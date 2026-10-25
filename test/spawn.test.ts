import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  atom,
  binaryToString,
  type ErlNode,
  ErpcError,
  Pid,
  SpawnError,
  start,
  TimeoutError,
  tuple,
} from "../src/index.ts";
import { COOKIE, inbox, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;
let node: ErlNode;

beforeAll(async () => {
  remote = await startNode("spawn_test");
  node = start({ name: "spawn_js@localhost", cookie: COOKIE });
  await node.connect(remote.name);
});

afterAll(async () => {
  await node.close();
  await remote.stop();
});

const alive = (pid: Pid) => node.rpc(remote.name, "erlang", "is_process_alive", [pid]);

test("spawn starts a process on the remote node", async () => {
  const mb = inbox(node);
  const { pid, ref } = await mb.spawnOn(remote.name, "timer", "sleep", [500]);
  expect(pid).toBeInstanceOf(Pid);
  expect(pid.node).toBe(atom(remote.name));
  expect(ref).toBeUndefined();
  expect(await alive(pid)).toBe(true);
  mb.exit();
});

test("spawn with monitor", async () => {
  const mb = inbox(node);
  const { pid, ref } = await mb.spawnOn(remote.name, "timer", "sleep", [50], { monitor: true });
  expect(await mb.receive(undefined, 2000)).toEqual(tuple(atom("DOWN"), ref!, atom("process"), pid, atom("normal")));
  mb.exit();
});

test("spawn with link", async () => {
  const mb = inbox(node);
  mb.trapExit = true;
  const { pid } = await mb.spawnOn(remote.name, "erlang", "exit", [atom("boom")], { link: true });
  expect(await mb.receive(undefined, 2000)).toEqual(tuple(atom("EXIT"), pid, atom("boom")));
  mb.exit();
});

test("spawn on an unknown node", async () => {
  const mb = inbox(node);
  const err = await mb.spawnOn("nobody@localhost", "erlang", "node").catch((e) => e);
  expect(err).toBeInstanceOf(SpawnError);
  expect(err.reason).toBe(atom("noconnection"));
  mb.exit();
});

test("erpc returns the value", async () => {
  expect(await node.erpc(remote.name, "erlang", "node")).toBe(atom(remote.name));
  expect(await node.erpc(remote.name, "lists", "seq", [1, 3])).toEqual([1, 2, 3]);
  const up = await node.erpc(remote.name, "Elixir.String", "upcase", ["abc"]);
  expect(binaryToString(up as Uint8Array)).toBe("ABC");
});

test("erpc exceptions keep their class", async () => {
  const thrown = await node.erpc(remote.name, "erlang", "throw", [atom("ball")]).catch((e) => e);
  expect(thrown).toBeInstanceOf(ErpcError);
  expect([thrown.kind, thrown.reason]).toEqual(["throw", atom("ball")]);

  const exited = await node.erpc(remote.name, "erlang", "exit", [atom("bye")]).catch((e) => e);
  expect([exited.kind, exited.reason]).toEqual(["exit", atom("bye")]);

  const errored = await node.erpc(remote.name, "erlang", "error", [atom("boom")]).catch((e) => e);
  expect([errored.kind, errored.reason]).toEqual(["error", atom("boom")]);
  expect(Array.isArray(errored.remoteStack)).toBe(true);
});

test("erpc that prints does not hang", async () => {
  expect(await node.erpc(remote.name, "Elixir.IO", "puts", ["from erpc"])).toBe(atom("ok"));
});

test("erpc timeout", async () => {
  await expect(node.erpc(remote.name, "timer", "sleep", [1000], 100)).rejects.toBeInstanceOf(TimeoutError);
});

test("erpc to an unknown node", async () => {
  const err = await node.erpc("nobody@localhost", "erlang", "node").catch((e) => e);
  expect(err).toBeInstanceOf(ErpcError);
  expect(err.reason).toEqual(tuple(atom("erpc"), atom("noconnection")));
});

test("spawn_request from BEAM to us is refused", async () => {
  expect(await node.rpc(remote.name, "Elixir.Helpers", "spawn_on", [node.name])).toEqual(
    tuple(atom("error"), atom("notsup")),
  );
});

test("erpc timeout covers a node that never answers the spawn request", async () => {
  const silent = start({ name: "spawn_silent@localhost", cookie: COOKIE });
  await silent.listen({ host: "127.0.0.1" });
  (silent as unknown as { dispatch: () => void }).dispatch = () => {};
  const started = Date.now();
  await expect(node.erpc(silent.name.name, "erlang", "node", [], 200)).rejects.toBeInstanceOf(TimeoutError);
  expect(Date.now() - started).toBeLessThan(1000);
  await silent.close();
});

test("node.module calls remote functions through erpc", async () => {
  const lists = node.module<"seq" | "no_such_function">(remote.name, "lists");
  expect(await lists.seq(1, 3)).toEqual([1, 2, 3]);
  const str = node.module(remote.name, "Elixir.String");
  expect(binaryToString((await str.upcase!("abc")) as Uint8Array)).toBe("ABC");
  expect(await str["valid?"]!("abc")).toBe(true);
  const err = await lists.no_such_function().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ErpcError);
  // Awaiting the proxy itself must not hang.
  expect(await lists).toBe(lists);
});

test("node.module typed by an interface", async () => {
  interface Lists {
    seq(from: number, to: number): Promise<number[]>;
    reverse(list: number[]): Promise<number[]>;
  }
  const lists = node.module<Lists>(remote.name, "lists");
  const seq: number[] = await lists.seq(1, 3);
  expect(await lists.reverse(seq)).toEqual([3, 2, 1]);
});
