import { afterAll, beforeAll, expect, test } from "bun:test";
import { atom, connect, ErlNode, type Term, Tuple, tuple } from "../src/index.ts";
import { COOKIE, startNode, type TestNode } from "./support/node.ts";

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
  listener = new ErlNode({ name: LISTENER, cookie: COOKIE });
  await listener.listen({ host: "127.0.0.1" });
  driver = await connect(remote.name, { name: "lis_driver@localhost", cookie: COOKIE });
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
  const mb = listener.spawnMailbox();
  mb.register("inbox");
  expect(await rpc("erlang", "send", [tuple(atom("inbox"), atom(LISTENER)), tuple(atom("hi"), 1)])).toEqual(
    tuple(atom("hi"), 1),
  );
  expect(await mb.receive(undefined, 2000)).toEqual(tuple(atom("hi"), 1));
  // We are connected as a hidden node.
  expect(await rpc("erlang", "nodes", [atom("hidden")])).toContainEqual(atom(LISTENER));
  expect(await rpc("erlang", "nodes")).toEqual([]);
  mb.close();
});

test("GenServer.call into a mailbox", async () => {
  const mb = listener.spawnMailbox();
  mb.register("server");
  void (async () => {
    const msg = (await mb.receive(undefined, 5000)) as Tuple;
    expect(msg.at(0)).toBe(atom("$gen_call"));
    await listener.reply(msg.at(1)!, tuple(atom("pong"), msg.at(2)!));
  })();
  const res = await rpc("Elixir.GenServer", "call", [tuple(atom("server"), atom(LISTENER)), atom("ping")]);
  expect(res).toEqual(tuple(atom("pong"), atom("ping")));
  mb.close();
});

test("remote monitors a registered mailbox by name", async () => {
  const mb = listener.spawnMailbox();
  mb.register("watched");
  const watcher = driver.spawnMailbox();
  await rpc("Elixir.Helpers", "watch", [tuple(atom("watched"), atom(LISTENER)), watcher.pid]);
  await Bun.sleep(100);
  mb.close(atom("bye"));
  expect(await watcher.receive(undefined, 2000)).toEqual(tuple(atom("down"), atom("bye")));

  await rpc("Elixir.Helpers", "watch", [tuple(atom("watched"), atom(LISTENER)), watcher.pid]);
  expect(await watcher.receive(undefined, 2000)).toEqual(tuple(atom("down"), atom("noproc")));
  watcher.close();
});

test("the listener can use the incoming connection", async () => {
  // The Elixir node connected to us; we reuse that connection instead of dialing.
  expect(await listener.rpc(remote.name, "erlang", "node")).toBe(atom(remote.name));
});

test("register rejects a taken name", () => {
  const a = listener.spawnMailbox();
  const b = listener.spawnMailbox();
  a.register("taken");
  expect(() => b.register("taken")).toThrow("already registered");
  a.close();
  b.register("taken");
  expect(listener.whereis("taken")).toBe(b);
  b.close();
});

test("close unregisters from EPMD", async () => {
  const n = new ErlNode({ name: "lis_tmp@localhost", cookie: COOKIE });
  await n.listen({ host: "127.0.0.1" });
  await n.close();
  await Bun.sleep(100);
  const names = await new Response(Bun.spawn(["epmd", "-names"]).stdout).text();
  expect(names).not.toContain("name lis_tmp ");
});

test("simultaneous connect between two listening nodes", async () => {
  for (let i = 0; i < 5; i++) {
    const a = new ErlNode({ name: `sim_a${i}@localhost`, cookie: COOKIE });
    const b = new ErlNode({ name: `sim_b${i}@localhost`, cookie: COOKIE });
    await a.listen({ host: "127.0.0.1" });
    await b.listen({ host: "127.0.0.1" });
    const [ab, ba] = await Promise.all([a.connect(b.name.name), b.connect(a.name.name)]);
    expect(ab.peerName).toBe(b.name.name);
    expect(ba.peerName).toBe(a.name.name);
    const mb = b.spawnMailbox();
    await a.send(mb.pid, atom("over_one_connection"));
    expect(await mb.receive(undefined, 2000)).toBe(atom("over_one_connection"));
    await a.close();
    await b.close();
  }
});
