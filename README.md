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
// Names are written as in Elixir: "Counter" is the module Counter
// (:"Elixir.Counter"), lowercase names like "lists" are Erlang modules.
await node.call(["Counter", APP], atom("inc"));

// :erpc.call: errors in the remote function throw ErpcError.
await node.erpc(APP, "erlang", "node"); // atom("app@localhost")

// :rpc.call: like in Erlang, errors come back as a {:badrpc, reason} value.
await node.rpc(APP, "erlang", "node");

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
| `Phoenix.PubSub.subscribe/2` | `self.subscribe(node, pubsub, topic)` |
| `use GenServer`, `GenServer.start_link/3` | `defineGenServer({...})`, `.start(node, opts)` |
| `exit/1`, `Process.exit/2` | `self.exit(reason)`, `node.exit(pid, reason)` |

One node keeps any number of connections, outgoing and incoming.

Module and process names follow Elixir: a name that starts with an
uppercase letter is an Elixir alias, so `"MyApp.Users"` means
`:"Elixir.MyApp.Users"`; lowercase names (`"lists"`, `"erlang"`) are Erlang
modules. This applies wherever erlnode expects a module or a registered
name. `atom("...")` is always taken literally, so atoms inside arguments
need the full name: `atom("Elixir.MyApp.Registry")`.

## High-level API

Shortcuts for common jobs, built on the API above. Each one is a process
with a loop you could write yourself; the sections below show how.

```ts
// Listen to a Phoenix.PubSub topic. Subscribes again if the connection or
// the subscription is lost; returns a function that unsubscribes.
const off = node.subscribe(APP, "MyApp.PubSub", "orders", (event) => {
  console.log(event);
});

// Answer GenServer.call / GenServer.cast to {:prices, :"js@localhost"}.
let price = 0;
node.serve("prices", {
  call: (req) => price,               // the return value is the reply
  cast: (req) => {
    const [op, value] = req as Tuple;  // GenServer.cast(pid, {:set, 42})
    if (op === atom("set")) price = value as number;
  },
  info: (msg) => console.log(msg),    // any other message
});

// Call functions of a remote module through :erpc. Listing the names
// is optional and only gives types.
const users = node.module<"get" | "list">(APP, "MyApp.Users");
await users.get(1);                   // :erpc.call(APP, MyApp.Users, :get, [1])

// Start a process again after a crash, like a :transient supervisor child.
node.spawn(async (self) => { /* ... */ }, { restart: { delay: 1000 } });
```

### defineGenServer

For a server with setup, cleanup or state worth naming, describe it once
the way Elixir does and start it as many times as needed:

```ts
import { atom, defineGenServer, toJS, type Tuple } from "erlnode";

const Rates = defineGenServer({
  init: async (self) => ({
    rates: await loadRates(),
    timer: setInterval(() => node.send(self.pid, atom("refresh")), 60_000),
  }),
  // GenServer.call(Rates, {:get, "EUR"})
  handleCall: (req, s) => {
    const [op, cur] = req as Tuple;
    if (op === atom("get")) return { reply: s.rates[toJS<string>(cur!)] ?? null, state: s };
  },
  // GenServer.cast(Rates, {:set, "EUR", 1.1})
  handleCast: (req, s) => {
    const [op, cur, rate] = req as Tuple;
    if (op === atom("set")) s.rates[toJS<string>(cur!)] = rate as number;
    return s;
  },
  // send(Rates, :refresh)
  handleInfo: async (msg, s) => (msg === atom("refresh") ? { ...s, rates: await loadRates() } : s),
  terminate: (_reason, s) => clearInterval(s.timer),
});

await Rates.start(node, { name: "Rates", restart: true });
```

- `start` resolves once `init` is done and rejects if it throws; a failed
  first start is not restarted.
- `handleCall` returns `{ reply, state }`; returning nothing means the
  request has no clause, and the server crashes so the caller gets an
  error instead of waiting for a timeout. `handleCast` and `handleInfo`
  return the new state.
- `terminate` runs whenever the process ends, killed or not, so it is the
  place for cleanup.
- State goes in and out of the callbacks, so they can be tested as plain
  functions, without a node.

`serve` is the short form for servers that need none of this.

- `serve` handles one message at a time. A handler that throws crashes the
  process and the pending call fails on the Elixir side; `serve(name,
  handlers, { restart })` brings it back.
- `module` checks nothing up front: a missing function fails when called.
  Names with `?` or `!` need brackets: `users["valid?"](x)`.
- `restart` does not restart after `:normal`, `:shutdown` or
  `{:shutdown, _}`. Each run gets a new pid; register a name for a stable
  address.

## Terms

| Erlang | JS (decode) | JS (encode) |
|---|---|---|
| integer | `number`, `bigint` outside the safe range | `number` (safe integer), `bigint` |
| float | `number` | `number` (non-integer), `float(x)` |
| atom | `Atom` (`atom("ok")`), `true`/`false` as booleans | `Atom`, `boolean` |
| binary | `Uint8Array` (`binaryToString` for text) | `Uint8Array`, `string` |
| list | array | array |
| charlist | array of numbers | array of numbers |
| tuple | `Tuple` (`t.at(i)`, `const [a, b] = t`) | `Tuple` (`tuple(...)`) |
| map | `Map` | `Map`, plain object (keys stay strings) |
| improper list | `ImproperList` | `ImproperList` |
| bitstring | `BitBinary` (bytes and bit count of the last byte) | `BitBinary` |
| `&m.f/a` | `Export` | `Export` |
| fun | `Fun` (opaque, can be sent back) | `Fun` |
| pid, reference, port | `Pid`, `Ref`, `Port` | `Pid`, `Ref`, `Port` |

Atoms are interned, so `atom("ok") === atom("ok")` and they work as `Map` keys.
`null` is encoded as `nil`.

Nothing from JS becomes an atom unless you ask for it: object keys stay
strings (`{ name: "Bob" }` → `%{"name" => "Bob"}`), strings stay binaries.
Atoms are never garbage collected and a node has a limit on them, so
turning outside data into atoms can bring the node down. When the Elixir
side wants atom keys, say so:

```ts
new Map([[atom("name"), "Bob"]]); // %{name: "Bob"}
```

`toJS(term)` turns a decoded term into plain JS data: atoms become strings
(`nil` becomes `null`), UTF-8 binaries become strings, tuples become arrays,
maps become objects. It loses information, so it is only applied when you
call it:

```ts
import { toJS } from "erlnode";

type User = { name: string; roles: string[]; manager: string | null };

const user = toJS<User>(await node.erpc(APP, "MyApp.Users", "get", [1]));
// %{name: "Bob", roles: [:admin], manager: nil}
// → { name: "Bob", roles: ["admin"], manager: null }
// The type parameter only saves a cast; nothing checks the data against it.
```

## What works

- EPMD lookup, handshake version 6 (OTP 23+), ticks.
- `send` to a pid, a local name or `[name, node]`.
- Processes: `node.spawn(fn)` runs `fn(self)` as a process with its own pid
  and mailbox. It exits with `:normal` when `fn` returns and with
  `{:js_error, message}` when it throws (the error is logged too).
  Messages between JS processes are copied as if they went over the wire:
  the receiver gets the same terms a remote process would, and nothing is
  shared with the sender.
- `call` (the gen_server protocol) and `rpc` (through `rex`).
  Output that the remote function writes is discarded. `call` monitors the
  target, so a missing or crashed process fails the call with `CallError`.
- `erpc` (`:erpc.call`): runs the function in a new process on the remote
  node; exceptions come back as `ErpcError` with the Erlang class and reason.
  Prefer it (or `node.module`) to `rpc`: a failed `rpc` does not throw, it
  returns `{:badrpc, reason}`, which is easy to miss.
- `self.subscribe(node, pubsub, topic)` subscribes to Phoenix.PubSub;
  `self.relay(node, m, f, args)` does the same for `Registry`, `:pg` or
  anything else that registers the caller. Nothing is deployed on the
  Elixir side.
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
  await self.send(["Prices", "app@localhost"], tuple(atom("subscribe"), self.pid));
  for await (const msg of self) console.log(msg);
});
```

Messages travel over the connection the JS node opened. If Elixir has to
connect first (we never connected, or the connection dropped), call
`node.listen()` so the JS node accepts connections.

### Subscribing to Phoenix.PubSub, Registry and :pg

A JS process can subscribe to a Phoenix.PubSub topic of a running Elixir app,
with no code added to the app:

```ts
node.spawn(async (self) => {
  await self.subscribe("app@localhost", "MyApp.PubSub", "orders");
  for await (const event of self) {
    console.log(event); // Phoenix.PubSub.broadcast(MyApp.PubSub, "orders", event)
  }
});
```

`subscribe` is built on `relay`, which works for anything that registers
the calling process. `relay(node, m, f, args)` starts a process on `node`
that calls `m.f(...args)` and then forwards every message it gets to the JS
process. The atom `$self` in `args` stands for the relay's pid:

```ts
// Registry.register(MyApp.Registry, "key", nil)
// (inside arguments, atom() needs the full Elixir name)
await self.relay(APP, "Registry", "register", [atom("Elixir.MyApp.Registry"), "key", atom("nil")]);

// :pg.join(:my_scope, "workers", relay_pid)
await self.relay(APP, "pg", "join", [atom("my_scope"), "workers", atom("$self")]);
```

The relay runs through `erl_eval`, so nothing has to be deployed on the
Elixir side. It is linked to the JS process and monitors it: when the JS
process exits or the connection drops, the relay exits and the subscription
is gone. If the relay dies, the JS process gets the exit signal. Both
`relay` and `subscribe` return `stop()` to unsubscribe and keep the process.

When the relay dies or the connection drops, the JS process gets an exit
signal. To keep listening, trap it and subscribe again. This is what
`node.subscribe` does:

```ts
node.spawn(async (self) => {
  self.trapExit = true;
  for (;;) {
    try {
      await self.subscribe(APP, "MyApp.PubSub", "orders");
      for await (const msg of self) {
        if (msg instanceof Tuple && msg.at(0) === atom("EXIT")) break; // subscription lost
        console.log(msg);
      }
    } catch {
      // node unreachable: wait and try again
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
});
```

### Answering GenServer.call and GenServer.cast

`defineGenServer` and `node.serve` do this for you. By hand, a JS process can stand in for a GenServer: `GenServer.call` arrives as
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
    const [tag, a, b] = msg as Tuple;
    if (tag === atom("$gen_call") && b === atom("inc")) {
      await node.reply(a!, ++count);
    } else if (tag === atom("$gen_cast")) {
      const [op, n] = a as Tuple;
      if (op === atom("add")) count += n as number;
    }
  }
});
```

## Debugging

Set `ERLNODE_DEBUG=1` to log connections and every control message to
stderr, in Erlang notation:

```
erlnode: connected to app@localhost
erlnode: → app@localhost MONITOR_P {19,#PID<js@localhost.2.0>,'Elixir.Counter',#Reference<js@localhost.1.2665438959.0>}
erlnode: → app@localhost REG_SEND {6,#PID<js@localhost.2.0>,'','Elixir.Counter'} {'$gen_call',{#PID<js@localhost.2.0>,#Reference<js@localhost.1.2665438959.0>},inc}
erlnode: app@localhost → SEND_SENDER {22,#PID<app@localhost.118.0>,#PID<js@localhost.2.0>} {#Reference<js@localhost.1.2665438959.0>,1}
erlnode: → app@localhost DEMONITOR_P {20,#PID<js@localhost.2.0>,'Elixir.Counter',#Reference<js@localhost.1.2665438959.0>}
erlnode: connection to app@localhost closed: connection closed by us
```

That is `node.call(["Counter", "app@localhost"], atom("inc"))`: a monitor on
the target, the `$gen_call` message, the reply `{ref, 1}`, the demonitor.
Payloads longer than 500 characters are cut. Without the variable nothing is
logged. The log shows message contents (never the cookie), so keep it off
where messages carry private data.

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
The Phoenix.PubSub test installs `phoenix_pubsub` with `Mix.install`, so its
first run needs access to hex.pm.
`ERLNODE_LONG=1 bun test` also runs a 3 minute keepalive test.

`scripts/test-otp.sh` runs the suite against OTP 23 to 29 with nix
(`scripts/test-otp.sh 25 26` for some of them). CI runs OTP 24 to 29;
GitHub's runners no longer support OTP 23.
