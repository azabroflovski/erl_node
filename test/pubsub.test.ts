import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { atom, type ErlNode, Pid, start, type Term, type Tuple, tuple } from "../src/index.ts";
import { COOKIE, inbox, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;
let node: ErlNode;

beforeAll(async () => {
  remote = await startNode("pubsub_test", { pubsub: true });
  node = start({ name: "pubsub_js@localhost", cookie: COOKIE });
  await node.connect(remote.name);
}, 90_000);

afterAll(async () => {
  await node.close();
  await remote.stop();
});

const broadcast = (topic: string, msg: Term) =>
  node.rpc(remote.name, "Elixir.Phoenix.PubSub", "broadcast", [atom("Elixir.TestPubSub"), topic, msg]);
const subscribers = (topic: string) =>
  node.rpc(remote.name, "Elixir.Registry", "count_match", [atom("Elixir.TestPubSub"), topic, atom("_")]);

test("subscribe to a Phoenix.PubSub topic", async () => {
  const p = inbox(node);
  await p.subscribe(remote.name, "Elixir.TestPubSub", "orders");
  expect(await broadcast("orders", tuple(atom("created"), 1))).toBe(atom("ok"));
  expect(await broadcast("other", atom("not_for_us"))).toBe(atom("ok"));
  expect(await broadcast("orders", tuple(atom("created"), 2))).toBe(atom("ok"));
  expect(await p.receive(undefined, 2000)).toEqual(tuple(atom("created"), 1));
  expect(await p.receive(undefined, 2000)).toEqual(tuple(atom("created"), 2));
  p.exit();
});

test("unsubscribe with stop() and when the process exits", async () => {
  const p = inbox(node);
  const { stop } = await p.subscribe(remote.name, "Elixir.TestPubSub", "temp");
  expect(await subscribers("temp")).toBe(1);
  await stop();
  await Bun.sleep(100);
  expect(await subscribers("temp")).toBe(0);

  await p.subscribe(remote.name, "Elixir.TestPubSub", "temp");
  expect(await subscribers("temp")).toBe(1);
  p.exit();
  await Bun.sleep(100);
  expect(await subscribers("temp")).toBe(0);
});

async function eventually(check: () => Promise<boolean> | boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

test("node.subscribe calls the handler and off() unsubscribes", async () => {
  const got: Term[] = [];
  const off = node.subscribe(remote.name, "Elixir.TestPubSub", "high", (event) => {
    got.push(event);
  });
  await eventually(async () => (await subscribers("high")) === 1);
  await broadcast("high", atom("one"));
  await broadcast("high", atom("two"));
  await eventually(() => got.length === 2);
  expect(got).toEqual([atom("one"), atom("two")]);
  await off();
  await eventually(async () => (await subscribers("high")) === 0);
});

test("node.subscribe subscribes again when the relay dies", async () => {
  const got: Term[] = [];
  const off = node.subscribe(remote.name, "Elixir.TestPubSub", "flaky", (e) => void got.push(e), { retry: 50 });
  await eventually(async () => (await subscribers("flaky")) === 1);
  const entries = (await node.rpc(remote.name, "Elixir.Registry", "lookup", [atom("Elixir.TestPubSub"), "flaky"])) as Tuple[];
  await node.rpc(remote.name, "erlang", "exit", [entries[0]!.at(0)!, atom("kill")]);
  await eventually(async () => (await subscribers("flaky")) === 1 && got.length === 0);
  await broadcast("flaky", atom("after_restart"));
  await eventually(() => got.length === 1);
  expect(got).toEqual([atom("after_restart")]);
  await off();
});

test("node.subscribe survives a dropped connection", async () => {
  const other = start({ name: "pubsub_js2@localhost", cookie: COOKIE });
  const got: Term[] = [];
  other.subscribe(remote.name, "Elixir.TestPubSub", "dropped", (e) => void got.push(e), { retry: 50 });
  await eventually(async () => (await subscribers("dropped")) === 1);
  const relayPid = async () =>
    ((await node.rpc(remote.name, "Elixir.Registry", "lookup", [atom("Elixir.TestPubSub"), "dropped"])) as Tuple[])[0]?.at(0);
  const before = await relayPid();
  other.disconnect(remote.name);
  // A new relay, over a new connection, replaces the old one.
  await eventually(async () => {
    const now = await relayPid();
    return now instanceof Pid && !now.equals(before);
  });
  await broadcast("dropped", atom("back"));
  await eventually(() => got.length === 1);
  await other.close();
});

test("a failing handler is logged and the subscription goes on", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const got: Term[] = [];
  const off = node.subscribe(remote.name, "Elixir.TestPubSub", "faulty", (e) => {
    if (e === atom("bad")) throw new Error("bad event");
    got.push(e);
  });
  await eventually(async () => (await subscribers("faulty")) === 1);
  await broadcast("faulty", atom("bad"));
  await broadcast("faulty", atom("good"));
  await eventually(() => got.length === 1);
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
  await off();
});
