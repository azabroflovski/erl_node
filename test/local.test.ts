import { afterAll, expect, spyOn, test } from "bun:test";
import { atom, type Pid, start, TimeoutError, tuple } from "../src/index.ts";
import { COOKIE, inbox } from "./support/node.ts";

// Links and monitors between two JS processes of the same node: no BEAM needed.
const node = start({ name: "local_js@localhost", cookie: COOKIE });
const NODE = atom("local_js@localhost");

afterAll(() => node.close());

test("monitor a local process", async () => {
  const watcher = inbox(node);
  const target = inbox(node);
  const ref = await watcher.monitor(target.pid);
  target.exit(atom("boom"));
  expect(await watcher.receive(undefined, 500)).toEqual(tuple(atom("DOWN"), ref, atom("process"), target.pid, atom("boom")));
  watcher.exit();
});

test("monitor a local name, and a missing one", async () => {
  const watcher = inbox(node);
  const target = inbox(node);
  target.register("local_named");
  const ref = await watcher.monitor(["local_named", node.name.name]);
  target.exit(atom("bye"));
  expect(await watcher.receive(undefined, 500)).toEqual(
    tuple(atom("DOWN"), ref, atom("process"), tuple(atom("local_named"), NODE), atom("bye")),
  );
  const missing = await watcher.monitor(["nobody", node.name.name]);
  expect(await watcher.receive(undefined, 500)).toEqual(
    tuple(atom("DOWN"), missing, atom("process"), tuple(atom("nobody"), NODE), atom("noproc")),
  );
  watcher.exit();
});

test("demonitor a local process", async () => {
  const watcher = inbox(node);
  const target = inbox(node);
  const ref = await watcher.monitor(target.pid);
  watcher.demonitor(ref);
  target.exit(atom("boom"));
  await expect(watcher.receive(undefined, 100)).rejects.toBeInstanceOf(TimeoutError);
  watcher.exit();
});

test("a watcher that exits first stops watching", async () => {
  const watcher = inbox(node);
  const target = inbox(node);
  await watcher.monitor(target.pid);
  watcher.exit();
  expect(target.monitoredBy.size).toBe(0);
  target.exit();
});

test("local link: a crash takes the other process down, a normal exit does not", async () => {
  const a = inbox(node);
  const b = inbox(node);
  await a.link(b.pid);
  b.exit(atom("boom"));
  await Bun.sleep(0);
  expect(a.alive).toBe(false);

  const c = inbox(node);
  const d = inbox(node);
  await c.link(d.pid);
  d.exit();
  await Bun.sleep(0);
  expect(c.alive).toBe(true);
  c.exit();
});

test("local link with trapExit, and unlink", async () => {
  const a = inbox(node);
  a.trapExit = true;
  const b = inbox(node);
  await b.link(a.pid); // either side can link
  b.exit(atom("boom"));
  expect(await a.receive(undefined, 500)).toEqual(tuple(atom("EXIT"), b.pid, atom("boom")));

  const c = inbox(node);
  await a.link(c.pid);
  await a.unlink(c.pid);
  c.exit(atom("boom"));
  await expect(a.receive(undefined, 100)).rejects.toBeInstanceOf(TimeoutError);
  a.exit();
});

test("linking to a dead local process gives noproc", async () => {
  const a = inbox(node);
  a.trapExit = true;
  const dead = inbox(node);
  dead.exit();
  await a.link(dead.pid);
  expect(await a.receive(undefined, 500)).toEqual(tuple(atom("EXIT"), dead.pid, atom("noproc")));
  a.exit();
});

async function eventually(check: () => boolean, timeout = 1000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

test("restart: a crashed process starts again with a new pid", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const pids: Pid[] = [];
  const first = node.spawn(
    async (self) => {
      pids.push(self.pid);
      self.register("restarting");
      const msg = await self.receive();
      if (msg === atom("crash")) throw new Error("asked to crash");
    },
    { restart: { delay: 10 } },
  );
  expect(node.whereis("restarting")).toEqual(first);
  await node.send("restarting", atom("crash"));
  await eventually(() => pids.length === 2 && node.whereis("restarting") !== undefined);
  expect(pids[1]!.equals(first)).toBe(false);
  expect(node.whereis("restarting")).toEqual(pids[1]);

  // :kill is abnormal too.
  await node.exit(pids[1]!, atom("kill"));
  await eventually(() => pids.length === 3 && node.whereis("restarting") !== undefined);

  // A normal return ends it for good.
  await node.send("restarting", atom("done"));
  await Bun.sleep(50);
  expect(pids.length).toBe(3);
  expect(node.whereis("restarting")).toBeUndefined();
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

test("restart: :shutdown is not restarted", async () => {
  let runs = 0;
  const pid = node.spawn(
    (self) => {
      runs++;
      return self.receive();
    },
    { restart: { delay: 10 } },
  );
  await node.exit(pid, atom("shutdown"));
  await Bun.sleep(50);
  expect(runs).toBe(1);
});

test("restart: node.close() stops restarting", async () => {
  const other = start({ name: "local_close@localhost", cookie: COOKIE });
  let runs = 0;
  const pid = other.spawn(
    (self) => {
      runs++;
      return self.receive();
    },
    { restart: { delay: 10 } },
  );
  await other.exit(pid, atom("kill"));
  await other.close();
  await Bun.sleep(50);
  expect(runs).toBe(1);
});

test("local messages are copies, as if they came over the wire", async () => {
  const p = inbox(node);
  const original = { list: [1, 2], text: "hi" };
  await node.send(p.pid, original);
  original.list.push(3);
  const got = (await p.receive(undefined, 500)) as Map<unknown, unknown>;
  const enc = (s: string) => new TextEncoder().encode(s);
  expect(got).toEqual(new Map<unknown, unknown>([[enc("list"), [1, 2]], [enc("text"), enc("hi")]]));
  await node.send(p.pid, null);
  expect(await p.receive(undefined, 500)).toBe(atom("nil"));
  p.exit();
});
