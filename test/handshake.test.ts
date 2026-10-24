import { afterAll, beforeAll, expect, test } from "bun:test";
import { atom, ErlNode, HandshakeError } from "../src/index.ts";
import { COOKIE, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;

beforeAll(async () => {
  remote = await startNode("hs_test");
});

afterAll(() => remote.stop());

test("handshake succeeds and we show up as a hidden node", async () => {
  const node = new ErlNode({ name: "hs_js@localhost", cookie: COOKIE });
  const conn = await node.connect(remote.name);
  expect(conn.peerName).toBe(remote.name);
  expect(await node.rpc(remote.name, "erlang", "nodes", [atom("hidden")])).toEqual([atom("hs_js@localhost")]);
  expect(await node.rpc(remote.name, "erlang", "nodes")).toEqual([]);
  await node.close();
});

test("wrong cookie fails fast", async () => {
  const node = new ErlNode({ name: "hs_bad@localhost", cookie: "wrong" });
  const started = Date.now();
  await expect(node.connect(remote.name)).rejects.toBeInstanceOf(HandshakeError);
  expect(Date.now() - started).toBeLessThan(2000);
});

test("unknown node", async () => {
  const node = new ErlNode({ name: "hs_js2@localhost", cookie: COOKIE });
  await expect(node.connect("nobody@localhost")).rejects.toThrow("not registered");
});
