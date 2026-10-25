import { afterAll, beforeAll, expect, test } from "bun:test";
import { atom, HandshakeError, start } from "../src/index.ts";
import { COOKIE, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;

beforeAll(async () => {
  remote = await startNode("hs_test");
});

afterAll(() => remote.stop());

test("handshake succeeds and we show up as a hidden node", async () => {
  const node = start({ name: "hs_js@localhost", cookie: COOKIE });
  await node.connect(remote.name);
  expect(node.list()).toEqual([remote.name]);
  expect(await node.rpc(remote.name, "erlang", "nodes", [atom("hidden")])).toEqual([atom("hs_js@localhost")]);
  expect(await node.rpc(remote.name, "erlang", "nodes")).toEqual([]);
  await node.close();
});

test("wrong cookie fails fast", async () => {
  const node = start({ name: "hs_bad@localhost", cookie: "wrong" });
  const started = Date.now();
  await expect(node.connect(remote.name)).rejects.toBeInstanceOf(HandshakeError);
  expect(Date.now() - started).toBeLessThan(2000);
});

test("unknown node", async () => {
  const node = start({ name: "hs_js2@localhost", cookie: COOKIE });
  await expect(node.connect("nobody@localhost")).rejects.toThrow("not registered");
});

test("a restarted node replaces its stale connection (BEAM answers alive)", async () => {
  const old = start({ name: "hs_restart@localhost", cookie: COOKIE });
  await old.connect(remote.name);
  const oldConn = old.connection(remote.name)!;
  // Same name, new instance, while BEAM still holds the old connection.
  const fresh = start({ name: "hs_restart@localhost", cookie: COOKIE });
  await fresh.connect(remote.name);
  expect(await fresh.rpc(remote.name, "erlang", "nodes", [atom("hidden")])).toEqual([atom("hs_restart@localhost")]);
  await oldConn.done;
  expect(old.list()).toEqual([]);
  await fresh.close();
  await old.close();
});
