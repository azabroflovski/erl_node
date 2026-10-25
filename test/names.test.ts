import { afterAll, beforeAll, expect, test } from "bun:test";
import { erlangName } from "../src/names.ts";
import { atom, binaryToString, type ErlNode, start, tuple } from "../src/index.ts";
import { COOKIE, inbox, startNode, type TestNode } from "./support/node.ts";

test("erlangName", () => {
  expect(erlangName("MyApp.Users")).toBe("Elixir.MyApp.Users");
  expect(erlangName("Counter")).toBe("Elixir.Counter");
  expect(erlangName("Elixir.Counter")).toBe("Elixir.Counter");
  expect(erlangName("lists")).toBe("lists");
  expect(erlangName("rex")).toBe("rex");
});

let remote: TestNode;
let node: ErlNode;

beforeAll(async () => {
  remote = await startNode("names_test");
  node = start({ name: "names_js@localhost", cookie: COOKIE });
  await node.connect(remote.name);
});

afterAll(async () => {
  await node.close();
  await remote.stop();
});

test("Elixir-style names in call, rpc, erpc, module and monitor", async () => {
  expect(await node.call(["Counter", remote.name], atom("get"))).toBe(0);
  expect(binaryToString((await node.rpc(remote.name, "String", "upcase", ["a"])) as Uint8Array)).toBe("A");
  expect(binaryToString((await node.erpc(remote.name, "String", "upcase", ["b"])) as Uint8Array)).toBe("B");
  const str = node.module<"upcase">(remote.name, "String");
  expect(binaryToString((await str.upcase("c")) as Uint8Array)).toBe("C");
  const p = inbox(node);
  const ref = await p.monitor(["Counter", remote.name]);
  p.demonitor(ref);
  p.exit();
});

test("a JS process registered as an alias receives Elixir's send({Inbox, node}, msg)", async () => {
  const p = inbox(node);
  p.register("Inbox");
  expect(node.whereis("Elixir.Inbox")).toEqual(p.pid);
  // What `send({Inbox, :"names_js@localhost"}, :hi)` sends from Elixir.
  await node.rpc(remote.name, "erlang", "send", [tuple(atom("Elixir.Inbox"), node.name), atom("hi")]);
  expect(await p.receive(undefined, 2000)).toBe(atom("hi"));
  p.exit();
});
