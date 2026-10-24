import { afterAll, beforeAll, expect, test } from "bun:test";
import { atom, binaryToString, connect, type ErlNode, Pid, TimeoutError, Tuple, tuple } from "../src/index.ts";
import { COOKIE, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;
let node: ErlNode;

beforeAll(async () => {
  remote = await startNode("app_test");
  node = await connect(remote.name, { name: "js_test@localhost", cookie: COOKIE });
});

afterAll(async () => {
  await node.close();
  await remote.stop();
});

test("send to a registered name, reply lands in the mailbox", async () => {
  const mb = node.spawnMailbox();
  await node.send("echo", tuple(mb.pid, ["hello", 42]));
  const reply = (await mb.receive(undefined, 2000)) as Tuple;
  expect(reply.at(0)).toBe(atom("echo"));
  const [hello, n] = reply.at(1) as [Uint8Array, number];
  expect(binaryToString(hello)).toBe("hello");
  expect(n).toBe(42);
  mb.close();
});

test("send to a pid", async () => {
  const echo = await node.rpc(remote.name, "erlang", "whereis", [atom("echo")]);
  expect(echo).toBeInstanceOf(Pid);
  const mb = node.spawnMailbox();
  await mb.send(echo as Pid, tuple(mb.pid, atom("ping")));
  expect(await mb.receive(undefined, 2000)).toEqual(tuple(atom("echo"), atom("ping")));
  mb.close();
});

test("receive with a pattern skips other messages", async () => {
  const mb = node.spawnMailbox();
  await node.send("echo", tuple(mb.pid, 1));
  await node.send("echo", tuple(mb.pid, 2));
  const second = await mb.receive((m) => m instanceof Tuple && m.at(1) === 2, 2000);
  expect((second as Tuple).at(1)).toBe(2);
  expect(((await mb.receive(undefined, 2000)) as Tuple).at(1)).toBe(1);
  await expect(mb.receive(undefined, 100)).rejects.toBeInstanceOf(TimeoutError);
  mb.close();
});

test("GenServer.call", async () => {
  expect(await node.call(remote.name, "Elixir.Counter", atom("inc"))).toBe(1);
  expect(await node.call(remote.name, "Elixir.Counter", atom("inc"))).toBe(2);
  expect(await node.call(remote.name, "Elixir.Counter", atom("get"))).toBe(2);
});

test("call to a missing name times out", async () => {
  await expect(node.call(remote.name, "nobody", atom("x"), 200)).rejects.toBeInstanceOf(TimeoutError);
});

test(":rpc.call", async () => {
  expect(await node.rpc(remote.name, "erlang", "node")).toBe(atom(remote.name));
  expect(await node.rpc(remote.name, "lists", "seq", [1, 3])).toEqual([1, 2, 3]);
  const bin = await node.rpc(remote.name, "Elixir.String", "upcase", ["abc"]);
  expect(binaryToString(bin as Uint8Array)).toBe("ABC");
});

test(":rpc.call that raises", async () => {
  const res = (await node.rpc(remote.name, "erlang", "error", [atom("boom")])) as Tuple;
  expect(res.at(0)).toBe(atom("badrpc"));
});

test(":rpc.call that prints does not hang", async () => {
  expect(await node.rpc(remote.name, "Elixir.IO", "puts", ["from rpc"])).toBe(atom("ok"));
});
