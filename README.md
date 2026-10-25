# erlnode

A JS/TS node for BEAM. It connects to an Erlang or Elixir node over the
native distribution protocol, without HTTP or WebSocket in between.

Runtime dependencies: none. Tested with Bun against OTP 28.

## Example

Start an Elixir node (the example below assumes it has a process registered
as `:echo` and a GenServer registered as `Counter`, like the one in
`test/support/node.ts`):

```sh
iex --sname app@localhost --cookie secret
```

Talk to it:

```ts
import { atom, start, tuple } from "erlnode";

const APP = "app@localhost";
const node = start({ name: "js@localhost", cookie: "secret" });

// Optional: connections open on first use, connect() just checks early.
await node.connect(APP);

// send({:echo, :"app@localhost"}, msg)
await node.send(["echo", APP], ["hello", 42]);

// GenServer.call({Counter, :"app@localhost"}, :inc).
// Elixir module names need the "Elixir." prefix.
await node.call(["Elixir.Counter", APP], atom("inc"));

// :rpc.call and :erpc.call
await node.rpc(APP, "erlang", "node"); // atom("app@localhost")
await node.erpc(APP, "erlang", "node"); // same, in a new remote process

// A process: a pid, a mailbox and a body. It exits when the body returns.
node.spawn(async (self) => {
  await self.send(["echo", APP], tuple(self.pid, "ping"));
  const reply = await self.receive(undefined, 5000);

  // A {:DOWN, ref, :process, object, reason} message arrives when :echo exits.
  const ref = await self.monitor(["echo", APP]);
  self.demonitor(ref);
});

await node.close();
```

The API follows Elixir:

| Elixir | erlnode |
|---|---|
| `Node.start/1` | `start({ name, cookie })` |
| `Node.connect/1`, `Node.disconnect/1`, `Node.list/0` | `node.connect(n)`, `node.disconnect(n)`, `node.list()` |
| `send(pid, msg)` | `node.send(pid, msg)` |
| `send({name, node}, msg)` | `node.send([name, node], msg)` |
| `send(name, msg)` for a local name | `node.send(name, msg)` |
| `GenServer.call(dest, req, timeout)` | `node.call(dest, req, timeout)` |
| `:rpc.call/5`, `:erpc.call/5` | `node.rpc(...)`, `node.erpc(...)` |
| `spawn/1` | `node.spawn(async (self) => ...)` |
| `Node.spawn/4` with `:link`, `:monitor` | `self.spawnOn(node, m, f, args, opts)` |
| `receive` | `self.receive(match, timeout)` |
| `Process.monitor/1`, `Process.link/1` | `self.monitor(dest)`, `self.link(pid)` |
| `Process.register/2`, `Process.whereis/1` | `self.register(name)`, `node.whereis(name)` |
| `Process.flag(:trap_exit, true)` | `self.trapExit = true` |
| `exit/1`, `Process.exit/2` | `self.exit(reason)`, `node.exit(pid, reason)` |

One node keeps any number of connections, outgoing and incoming.

## Terms

| Erlang | JS (decode) | JS (encode) |
|---|---|---|
| integer | `number`, `bigint` outside the safe range | `number` (safe integer), `bigint` |
| float | `number` | `number` (non-integer), `float(x)` |
| atom | `Atom` (`atom("ok")`), `true`/`false` as booleans | `Atom`, `boolean` |
| binary | `Uint8Array` (`binaryToString` for text) | `Uint8Array`, `string` |
| list | array | array |
| charlist | array of numbers | array of numbers |
| tuple | `Tuple` | `Tuple` (`tuple(...)`) |
| map | `Map` | `Map`, plain object (keys become atoms) |
| improper list | `ImproperList` | `ImproperList` |
| bitstring | `BitBinary` (bytes and bit count of the last byte) | `BitBinary` |
| `&m.f/a` | `Export` | `Export` |
| fun | `Fun` (opaque, can be sent back) | `Fun` |
| pid, reference, port | `Pid`, `Ref`, `Port` | `Pid`, `Ref`, `Port` |

Atoms are interned, so `atom("ok") === atom("ok")` and they work as `Map` keys.

## What works

- EPMD lookup, handshake version 6 (OTP 23+), ticks.
- `send` to a pid, a local name or `[name, node]`.
- Processes: `node.spawn(fn)` runs `fn(self)` as a process with its own pid
  and mailbox. It exits with `:normal` when `fn` returns and with
  `{:js_error, message}` when it throws (the error is logged too).
- `call` (the gen_server protocol) and `rpc` (through `rex`).
  Output that the remote function writes is discarded. `call` monitors the
  target, so a missing or crashed process fails the call with `CallError`.
- `erpc` (`:erpc.call`): runs the function in a new process on the remote
  node; exceptions come back as `ErpcError` with the Erlang class and reason.
- `self.spawnOn(node, m, f, args, { link, monitor })` starts a process on
  the remote node (`spawn_request`). Spawn requests from BEAM to us are
  answered with `notsup`: the JS node cannot run Erlang code.
- Links and monitors in both directions, with Erlang's exit rules: a linked
  process exiting with a non-normal reason takes ours down, unless
  `trapExit` is set and the signal arrives as `{:EXIT, from, reason}`;
  `:kill` cannot be trapped. Monitors deliver
  `{:DOWN, ref, :process, object, reason}`. When a connection drops, links
  and monitors over it fire with `:noconnection`.
- Incoming connections after `node.listen()`: the node registers in the local
  EPMD and accepts handshakes. Processes can be registered under a name
  (`self.register("inbox")`), so Erlang code can use `send({:inbox, :"js@host"}, msg)`,
  monitor `{:inbox, :"js@host"}` or `GenServer.call` it (answer with `node.reply(from, value)`).

The node is hidden, so it shows up in `Node.list(:hidden)` and not in
`Node.list()`. Without `listen()` it only makes outgoing connections.
`listen()` binds all interfaces unless `host` is given, like `erl` does.

Also:

- Fragmented messages (`DFLAG_FRAGMENTS`): BEAM sends large messages in
  64 KB pieces, possibly interleaved between senders; they are put back
  together per sender. Our own messages go out whole.

Not supported yet: TLS distribution, the atom cache.

## Receiving connections

```ts
import { start } from "erlnode";

const node = start({ name: "js@localhost", cookie: "secret" });
await node.listen();

node.spawn(async (self) => {
  self.register("inbox");
  for (;;) {
    const msg = await self.receive(); // send({:inbox, :"js@localhost"}, :hi) in iex
    console.log(msg);
  }
});
```

### Answering GenServer.call and GenServer.cast

A JS process can stand in for a GenServer: `GenServer.call` arrives as
`{:"$gen_call", from, request}` and is answered with `node.reply(from, value)`,
`GenServer.cast` arrives as `{:"$gen_cast", request}`. State is a plain variable.

```ts
import { atom, start, type Tuple } from "erlnode";

const node = start({ name: "js@localhost", cookie: "secret" });
await node.listen();

// GenServer.cast({:counter, :"js@localhost"}, {:add, 5})
// GenServer.call({:counter, :"js@localhost"}, :inc) #=> 6
node.spawn(async (self) => {
  self.register("counter");
  let count = 0;
  for (;;) {
    const [tag, a, b] = ((await self.receive()) as Tuple).elements;
    if (tag === atom("$gen_call") && b === atom("inc")) {
      await node.reply(a!, ++count);
    } else if (tag === atom("$gen_cast")) {
      const [op, n] = (a as Tuple).elements;
      if (op === atom("add")) count += n as number;
    }
  }
});
```

## Security

The cookie gives full access to the remote node: whoever has it can run any
code there. Keep it out of logs and source control, and do not expose the
distribution port to untrusted networks.

## Tests

```sh
bun test
```

Tests start real Elixir nodes, so `elixir` and `epmd` must be on the PATH.
`ERLNODE_LONG=1 bun test` also runs a 3 minute keepalive test.
