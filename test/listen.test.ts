import { afterAll, beforeAll, expect, test } from "bun:test";
import { atom, type ErlNode, start, type Term, Tuple, tuple } from "../src/index.ts";
import { COOKIE, inbox, startNode, type TestNode } from "./support/node.ts";

// `listener` only accepts connections, it never connects anywhere itself.
// `driver` asks the Elixir node (over rpc) to talk to `listener`, so every
// connection between the Elixir node and `listener` is an incoming one.
const LISTENER = "lis_js@localhost";

let remote: TestNode;
let listener: ErlNode;
let driver: ErlNode;

const rpc = (m: string, f: string, args: Term[] = []) => driver.rpc(remote.name, m, f, args);

beforeAll(async () => {
  remote = await startNode("lis_test");
  listener = start({ name: LISTENER, cookie: COOKIE });
  await listener.listen({ host: "127.0.0.1" });
  driver = start({ name: "lis_driver@localhost", cookie: COOKIE });
  await driver.connect(remote.name);
});

afterAll(async () => {
  await driver.close();
  await listener.close();
  await remote.stop();
});

test("registered in EPMD", async () => {
  const names = await new Response(Bun.spawn(["epmd", "-names"]).stdout).text();
  expect(names).toContain("name lis_js at port");
});

test("wrong cookie is refused", async () => {
  await rpc("erlang", "set_cookie", [atom(LISTENER), atom("wrong")]);
  expect(await rpc("net_kernel", "connect_node", [atom(LISTENER)])).toBe(false);
  await rpc("erlang", "set_cookie", [atom(LISTENER), atom(COOKIE)]);
});

test("remote sends to a registered mailbox", async () => {
  const mb = inbox(listener);
  mb.register("inbox");
  expect(await rpc("erlang", "send", [tuple(atom("inbox"), atom(LISTENER)), tuple(atom("hi"), 1)])).toEqual(
    tuple(atom("hi"), 1),
  );
  expect(await mb.receive(undefined, 2000)).toEqual(tuple(atom("hi"), 1));
  // We are connected as a hidden node.
  expect(await rpc("erlang", "nodes", [atom("hidden")])).toContainEqual(atom(LISTENER));
  expect(await rpc("erlang", "nodes")).toEqual([]);
  mb.exit();
});

test("GenServer.call and GenServer.cast into a JS process (README example)", async () => {
  // Same body as in the README.
  const pid = listener.spawn(async (self) => {
    self.register("counter");
    let count = 0;
    for (;;) {
      const [tag, a, b] = ((await self.receive()) as Tuple).elements;
      if (tag === atom("$gen_call") && b === atom("inc")) {
        await listener.reply(a!, ++count);
      } else if (tag === atom("$gen_cast")) {
        const [op, n] = (a as Tuple).elements;
        if (op === atom("add")) count += n as number;
      }
    }
  });
  const counter = tuple(atom("counter"), atom(LISTENER));
  expect(await rpc("Elixir.GenServer", "cast", [counter, tuple(atom("add"), 5)])).toBe(atom("ok"));
  expect(await rpc("Elixir.GenServer", "call", [counter, atom("inc")])).toBe(6);
  expect(await rpc("Elixir.GenServer", "call", [counter, atom("inc")])).toBe(7);
  await listener.exit(pid, atom("kill"));
});

test("remote monitors a registered mailbox by name", async () => {
  const mb = inbox(listener);
  mb.register("watched");
  const watcher = inbox(driver);
  await rpc("Elixir.Helpers", "watch", [tuple(atom("watched"), atom(LISTENER)), watcher.pid]);
  await Bun.sleep(100);
  mb.exit(atom("bye"));
  expect(await watcher.receive(undefined, 2000)).toEqual(tuple(atom("down"), atom("bye")));

  await rpc("Elixir.Helpers", "watch", [tuple(atom("watched"), atom(LISTENER)), watcher.pid]);
  expect(await watcher.receive(undefined, 2000)).toEqual(tuple(atom("down"), atom("noproc")));
  watcher.exit();
});

test("the listener can use the incoming connection", async () => {
  // The Elixir node connected to us; we reuse that connection instead of dialing.
  expect(await listener.rpc(remote.name, "erlang", "node")).toBe(atom(remote.name));
});

test("register rejects a taken name", () => {
  const a = inbox(listener);
  const b = inbox(listener);
  a.register("taken");
  expect(() => b.register("taken")).toThrow("already registered");
  a.exit();
  b.register("taken");
  expect(listener.whereis("taken")).toEqual(b.pid);
  b.exit();
});

test("close unregisters from EPMD", async () => {
  const n = start({ name: "lis_tmp@localhost", cookie: COOKIE });
  await n.listen({ host: "127.0.0.1" });
  await n.close();
  await Bun.sleep(100);
  const names = await new Response(Bun.spawn(["epmd", "-names"]).stdout).text();
  expect(names).not.toContain("name lis_tmp ");
});

test("simultaneous connect between two listening nodes", async () => {
  for (let i = 0; i < 5; i++) {
    const a = start({ name: `sim_a${i}@localhost`, cookie: COOKIE });
    const b = start({ name: `sim_b${i}@localhost`, cookie: COOKIE });
    await a.listen({ host: "127.0.0.1" });
    await b.listen({ host: "127.0.0.1" });
    await Promise.all([a.connect(b.name.name), b.connect(a.name.name)]);
    expect(a.list()).toEqual([b.name.name]);
    expect(b.list()).toEqual([a.name.name]);
    const mb = inbox(b);
    await a.send(mb.pid, atom("over_one_connection"));
    expect(await mb.receive(undefined, 2000)).toBe(atom("over_one_connection"));
    await a.close();
    await b.close();
  }
});

test("a restarted peer replaces its stale connection (we answer alive)", async () => {
  const a = start({ name: "alive_a@localhost", cookie: COOKIE });
  await a.listen({ host: "127.0.0.1" });
  const old = start({ name: "alive_b@localhost", cookie: COOKIE });
  await old.connect(a.name.name);
  const oldConn = old.connection(a.name.name)!;
  const fresh = start({ name: "alive_b@localhost", cookie: COOKIE });
  await fresh.connect(a.name.name);
  await oldConn.done;
  expect(a.list()).toEqual(["alive_b@localhost"]);
  const p = inbox(a);
  await fresh.send(p.pid, atom("from_fresh"));
  expect(await p.receive(undefined, 2000)).toBe(atom("from_fresh"));
  await fresh.close();
  await old.close();
  await a.close();
});
