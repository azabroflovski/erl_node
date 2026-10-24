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

Connect to it:

```ts
import { atom, connect, tuple } from "erlnode";

const node = await connect("app@localhost", { name: "js@localhost", cookie: "secret" });

// Send to a registered process.
await node.send("echo", ["hello", 42]);

// GenServer.call. Elixir module names need the "Elixir." prefix.
await node.call("app@localhost", "Elixir.Counter", atom("inc"));

// :rpc.call
await node.rpc("app@localhost", "erlang", "node"); // atom("app@localhost")

// A mailbox has its own pid, so remote processes can reply to it.
const mb = node.spawnMailbox();
await node.send("echo", tuple(mb.pid, "ping"));
const reply = await mb.receive(undefined, 5000);

// A {:DOWN, ref, :process, object, reason} message arrives when :echo exits.
const ref = await mb.monitor("echo");
mb.demonitor(ref);

await node.close();
```

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
- `send` to a pid or a registered name.
- Mailboxes with `receive(match, timeout)`.
- `call` (the gen_server protocol) and `rpc` (through `rex`).
  Output that the remote function writes is discarded. `call` monitors the
  target, so a missing or crashed process fails the call with `CallError`.
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

- Fragmented messages (`DFLAG_FRAGMENTS`) in both directions. Large messages
  go out in 64 KB pieces. Incoming pieces from different remote processes
  may arrive interleaved and are put back together per sender.

Not supported yet: TLS distribution, the atom cache.

## Receiving connections

```ts
import { ErlNode } from "erlnode";

const node = new ErlNode({ name: "js@localhost", cookie: "secret" });
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
