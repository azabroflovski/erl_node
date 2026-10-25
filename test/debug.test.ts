import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { format, start } from "../src/index.ts";
import { COOKIE, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;

beforeAll(async () => {
  remote = await startNode("debug_test");
});

afterAll(() => remote.stop());

test("ERLNODE_DEBUG logs connections and messages", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  process.env.ERLNODE_DEBUG = "1";
  try {
    const node = start({ name: "debug_js@localhost", cookie: COOKIE });
    await node.rpc(remote.name, "String", "upcase", ["bob"]);
    await node.connect("nobody@localhost").catch(() => {});
    await node.close();
    const lines = log.mock.calls.map((c) => String(c[0]));
    const has = (part: string) => lines.some((l) => l.includes(part));
    expect(has(`erlnode: connected to ${remote.name}`)).toBe(true);
    expect(has(`erlnode: → ${remote.name} MONITOR_P`)).toBe(true);
    expect(has(`erlnode: → ${remote.name} REG_SEND`)).toBe(true);
    expect(has(`erlnode: ${remote.name} → SEND_SENDER`)).toBe(true);
    expect(has(`<<"BOB">>`)).toBe(true);
    expect(has("erlnode: connecting to nobody@localhost failed")).toBe(true);
    expect(has(`erlnode: connection to ${remote.name} closed`)).toBe(true);
  } finally {
    delete process.env.ERLNODE_DEBUG;
    log.mockRestore();
  }
});

test("silent without ERLNODE_DEBUG", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const node = start({ name: "debug_js2@localhost", cookie: COOKIE });
  await node.rpc(remote.name, "erlang", "node");
  await node.close();
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});

test("format shows text binaries like Erlang", () => {
  expect(format(new TextEncoder().encode("Bob"))).toBe('<<"Bob">>');
  expect(format(new Uint8Array([0, 255]))).toBe("<<0,255>>");
  expect(format(new Uint8Array([]))).toBe("<<>>");
});
