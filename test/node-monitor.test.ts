import { expect, spyOn, test } from "bun:test";
import { start } from "../src/index.ts";
import { COOKIE, startNode } from "./support/node.ts";

async function eventually(check: () => boolean, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

test(
  "node.monitor reports down, up, down and up again with reconnect",
  async () => {
    const node = start({ name: "nm_js@localhost", cookie: COOKIE });
    const events: string[] = [];
    const stop = node.monitor("nm_app@localhost", (event) => events.push(event), { reconnect: 100 });
    await eventually(() => events.length === 1);
    expect(events).toEqual(["down"]); // not connected yet, and the node does not exist

    let app = await startNode("nm_app");
    await eventually(() => events.length === 2); // reconnect found it
    expect(events).toEqual(["down", "up"]);

    await app.stop();
    await eventually(() => events.length === 3);
    expect(events[2]).toBe("down");

    app = await startNode("nm_app");
    await eventually(() => events.length === 4);
    expect(events[3]).toBe("up");

    stop();
    await app.stop();
    await Bun.sleep(200);
    expect(events.length).toBe(4); // no events after stop()
    await node.close();
  },
  60_000,
);

test("without reconnect only transitions caused by our own connects are reported", async () => {
  const app = await startNode("nm_app2");
  const node = start({ name: "nm_js2@localhost", cookie: COOKIE });
  await node.connect(app.name);
  const events: string[] = [];
  node.monitor(app.name, (event, reason) => events.push(`${event}${reason ? `: ${reason}` : ""}`));
  await Bun.sleep(50);
  expect(events).toEqual([]); // already connected: nothing to report
  node.disconnect(app.name);
  await eventually(() => events.length === 1);
  expect(events[0]).toStartWith("down");
  await Bun.sleep(300);
  expect(events.length).toBe(1); // nobody reconnects
  await node.rpc(app.name, "erlang", "node");
  await eventually(() => events.length === 2);
  expect(events[1]).toBe("up");
  await node.close();
  await app.stop();
});

test("a throwing handler is logged", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const node = start({ name: "nm_js3@localhost", cookie: COOKIE });
  node.monitor("nobody@localhost", () => {
    throw new Error("oops");
  });
  await Bun.sleep(20);
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
  await node.close();
});
