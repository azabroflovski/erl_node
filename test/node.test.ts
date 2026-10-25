import { afterAll, beforeAll, expect, test } from "bun:test";
import { atom, binaryToString, CallError, type ErlNode, Fun, Pid, start, TimeoutError, Tuple, tuple } from "../src/index.ts";
import { COOKIE, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;
let node: ErlNode;

beforeAll(async () => {
  remote = await startNode("app_test");
  node = start({ name: "js_test@localhost", cookie: COOKIE });
  await node.connect(remote.name);
});

afterAll(async () => {
  await node.close();
  await remote.stop();
});

test("send to a registered name, reply lands in the mailbox", async () => {
  const mb = node.spawnMailbox();
  await node.send(["echo", remote.name], tuple(mb.pid, ["hello", 42]));
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
  await node.send(["echo", remote.name], tuple(mb.pid, 1));
  await node.send(["echo", remote.name], tuple(mb.pid, 2));
  const second = await mb.receive((m) => m instanceof Tuple && m.at(1) === 2, 2000);
  expect((second as Tuple).at(1)).toBe(2);
  expect(((await mb.receive(undefined, 2000)) as Tuple).at(1)).toBe(1);
  await expect(mb.receive(undefined, 100)).rejects.toBeInstanceOf(TimeoutError);
  mb.close();
});

test("GenServer.call", async () => {
  expect(await node.call(["Elixir.Counter", remote.name], atom("inc"))).toBe(1);
  expect(await node.call(["Elixir.Counter", remote.name], atom("inc"))).toBe(2);
  expect(await node.call(["Elixir.Counter", remote.name], atom("get"))).toBe(2);
});

test("call to a missing name fails with noproc", async () => {
  const err = await node.call(["nobody", remote.name], atom("x")).catch((e) => e);
  expect(err).toBeInstanceOf(CallError);
  expect(err.reason).toBe(atom("noproc"));
});

test("call that gets no reply times out", async () => {
  await expect(node.call(["echo", remote.name], atom("x"), 200)).rejects.toBeInstanceOf(TimeoutError);
});

test("call to a process that exits before replying", async () => {
  const started = (await node.rpc(remote.name, "Elixir.GenServer", "start", [atom("Elixir.Counter"), 0])) as Tuple;
  const err = await node.call(started.at(1) as Pid, atom("stop")).catch((e) => e);
  expect(err).toBeInstanceOf(CallError);
  expect(err.reason).toBe(atom("bye"));
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

test("a fun from the remote node can be sent back and called there", async () => {
  const fun = await node.rpc(remote.name, "Elixir.Funs", "adder", [5]);
  expect(fun).toBeInstanceOf(Fun);
  expect(await node.rpc(remote.name, "erlang", "apply", [fun, [1]])).toBe(6);
});

test(":rpc.call that prints does not hang", async () => {
  expect(await node.rpc(remote.name, "Elixir.IO", "puts", ["from rpc"])).toBe(atom("ok"));
});

test("list and disconnect", async () => {
  const other = start({ name: "js_list@localhost", cookie: COOKIE });
  expect(other.list()).toEqual([]);
  await other.connect(remote.name);
  await other.connect(remote.name); // already connected: no-op
  expect(other.list()).toEqual([remote.name]);
  other.disconnect(remote.name);
  await Bun.sleep(50);
  expect(other.list()).toEqual([]);
  // Connects again on first use.
  expect(await other.rpc(remote.name, "erlang", "node")).toBe(atom(remote.name));
  expect(other.list()).toEqual([remote.name]);
  await other.close();
});

test("local sends", async () => {
  const mb = node.spawnMailbox();
  mb.register("local_inbox");
  await node.send("local_inbox", 1);
  await node.send(["local_inbox", node.name.name], 2);
  await node.send(mb.pid, 3);
  expect([await mb.receive(), await mb.receive(), await mb.receive()]).toEqual([1, 2, 3]);
  mb.close();
  await expect(node.send("local_inbox", 4)).rejects.toThrow("no process registered");
});
