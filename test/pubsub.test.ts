import { afterAll, beforeAll, expect, test } from "bun:test";
import { atom, type ErlNode, start, type Term, tuple } from "../src/index.ts";
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
