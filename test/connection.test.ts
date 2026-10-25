import { afterAll, beforeAll, expect, test } from "bun:test";
import { atom, start } from "../src/index.ts";
import { COOKIE, startNode, type TestNode } from "./support/node.ts";

// net_ticktime 4 makes the remote tick every second and drop a silent
// connection after about 4 s, so 15 s here covers many tick periods.
// Set ERLNODE_LONG=1 to also run the 3 minute variant with default ticktime.
const HOLD = 15_000;

let remote: TestNode;

beforeAll(async () => {
  remote = await startNode("conn_test", { erl: "-kernel net_ticktime 4" });
});

afterAll(() => remote.stop());

test(
  "connection survives ticks",
  async () => {
    const node = start({ name: "conn_js@localhost", cookie: COOKIE });
    await node.connect(remote.name);
    const conn = node.connection(remote.name)!;
    expect(await node.rpc(remote.name, "net_kernel", "get_net_ticktime")).toBe(4);
    let lost: Error | undefined;
    conn.done.then((err) => (lost = err));
    await Bun.sleep(HOLD);
    expect(lost).toBeUndefined();
    expect(await node.rpc(remote.name, "erlang", "nodes", [atom("hidden")])).toEqual([atom("conn_js@localhost")]);
    await node.close();
  },
  HOLD + 10_000,
);

test.skipIf(!process.env.ERLNODE_LONG)(
  "connection survives 3 minutes with default ticktime",
  async () => {
    const slow = await startNode("conn_long");
    try {
      const node = start({ name: "conn_long_js@localhost", cookie: COOKIE });
      await node.connect(slow.name);
      const conn = node.connection(slow.name)!;
      let lost: Error | undefined;
      conn.done.then((err) => (lost = err));
      await Bun.sleep(180_000);
      expect(lost).toBeUndefined();
      expect(await node.rpc(slow.name, "erlang", "node")).toBe(atom(slow.name));
      await node.close();
    } finally {
      await slow.stop();
    }
  },
  200_000,
);
