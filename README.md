# erlnode

![OTP 23–29](https://img.shields.io/badge/OTP-23%E2%80%9329-A90533)
![Elixir 1.14–1.20](https://img.shields.io/badge/Elixir-1.14%E2%80%931.20-4B275F)
![Bun](https://img.shields.io/badge/runtime-Bun-black)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A JS/TS node for BEAM. It connects to an Erlang or Elixir node over the
native distribution protocol.

Zero dependencies: the term codec and the protocol are written from scratch.
Tested with Bun against OTP 23 to 29.

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

## Receiving messages from Elixir

A JS process reads its mailbox with `for await`. Elixir can reach it in two ways.

By a name registered on the JS node:

```ts
import { atom, start, tuple } from "erlnode";

const node = start({ name: "js@localhost", cookie: "secret" });
await node.connect("app@localhost");

node.spawn(async (self) => {
  self.register("updates");
  for await (const msg of self) {
    console.log("from elixir:", msg); // send({:updates, :"js@localhost"}, {:price, 42})
  }
});
```

By pid: the JS process sends its pid first, Elixir keeps it and sends to it
later. For Elixir it is an ordinary remote pid: `send`, `Process.monitor` and
`Process.link` work on it, and `:DOWN` arrives when the JS process exits or
the connection drops.

```ts
node.spawn(async (self) => {
  await self.send(["Elixir.Prices", "app@localhost"], tuple(atom("subscribe"), self.pid));
  for await (const msg of self) console.log(msg);
});
```

Messages travel over the connection the JS node opened. If Elixir has to
connect first (we never connected, or the connection dropped), call
`node.listen()` so the JS node accepts connections.

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
  for await (const msg of self) {
    const [tag, a, b] = (msg as Tuple).elements;
    if (tag === atom("$gen_call") && b === atom("inc")) {
      await node.reply(a!, ++count);
    } else if (tag === atom("$gen_cast")) {
      const [op, n] = (a as Tuple).elements;
      if (op === atom("add")) count += n as number;
    }
  }
});
```

## Compatibility

The full test suite passes against live nodes of each of these releases
(last run on 2026-10-25 with Bun 1.4.2):

| OTP | Elixir |
|---|---|
| 23.3 | 1.14 |
| 24.3 | 1.14 |
| 25.3 | 1.14 |
| 26.2 | 1.15 |
| 27.3 | 1.18 |
| 28.5 | 1.20 |
| 29.1 | 1.18 |

To repeat it: `scripts/test-otp.sh` (needs nix).

One known gap: ports are always encoded as `V4_PORT_EXT`, which OTP 23 does
not read, so a port cannot be sent to an OTP 23 node.

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

`scripts/test-otp.sh` runs the suite against OTP 23 to 29 with nix
(`scripts/test-otp.sh 25 26` for some of them). CI runs OTP 24 to 29;
GitHub's runners no longer support OTP 23.
