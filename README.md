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

// A mailbox has its own pid, so remote processes can reply to it.
const mb = node.spawnMailbox();
await mb.send(["echo", APP], tuple(mb.pid, "ping"));
const reply = await mb.receive(undefined, 5000);

// A {:DOWN, ref, :process, object, reason} message arrives when :echo exits.
const ref = await mb.monitor(["echo", APP]);
mb.demonitor(ref);

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
| `Process.monitor/1`, `Process.link/1` | `mb.monitor(dest)`, `mb.link(pid)` |
| `Process.register/2` | `mb.register(name)` |

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
- Mailboxes with `receive(match, timeout)`.
- `call` (the gen_server protocol) and `rpc` (through `rex`).
  Output that the remote function writes is discarded. `call` monitors the
  target, so a missing or crashed process fails the call with `CallError`.
- `erpc` (`:erpc.call`): runs the function in a new process on the remote
  node; exceptions come back as `ErpcError` with the Erlang class and reason.
- `mailbox.spawn(node, m, f, args, { link, monitor })` starts a process on
  the remote node (`spawn_request`). Spawn requests from BEAM to us are
  answered with `notsup`: the JS node cannot run Erlang code.
- Links and monitors in both directions. A mailbox behaves like a process
  that traps exits: exit signals arrive as `{:EXIT, from, reason}`, monitors
  deliver `{:DOWN, ref, :process, object, reason}`. `mailbox.close(reason)`
  sends exit signals to linked and monitoring processes. When a connection
  drops, links and monitors over it fire with `:noconnection`.
- Incoming connections after `node.listen()`: the node registers in the local
  EPMD and accepts handshakes. Mailboxes can be registered under a name
  (`mb.register("inbox")`), so Erlang code can use `send({:inbox, :"js@host"}, msg)`,
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

const inbox = node.spawnMailbox();
inbox.register("inbox");
const msg = await inbox.receive(); // after send({:inbox, :"js@localhost"}, :hi) in iex
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
