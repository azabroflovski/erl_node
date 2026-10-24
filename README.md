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
  Output that the remote function writes is discarded.

The node only makes outgoing connections and does not register in EPMD.
It connects as a hidden node, so it shows up in `Node.list(:hidden)`
and not in `Node.list()`.

Not supported yet: links and monitors, incoming connections, fragmented
messages, TLS distribution.

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
