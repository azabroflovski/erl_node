import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
  atom,
  CallError,
  defineGenServer,
  type ErlNode,
  Pid,
  start,
  type Term,
  toJS,
  type Tuple,
  tuple,
} from "../src/index.ts";
import { COOKIE, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;
let node: ErlNode;
let JS: string;

beforeAll(async () => {
  remote = await startNode("gs_test");
  node = start({ name: "gs_js@localhost", cookie: COOKIE });
  JS = node.name.name;
  await node.connect(remote.name);
});

afterAll(async () => {
  await node.close();
  await remote.stop();
});

// Calls made by Elixir code on the remote node, back into the JS node.
const elixir = (f: string, args: Term[]) => node.rpc(remote.name, "GenServer", f, args);

const Counter = defineGenServer({
  init: (_self, start: number) => start,
  handleCall: (req, n) => {
    if (req === atom("inc")) return { reply: n + 1, state: n + 1 };
    if (req === atom("get")) return { reply: n, state: n };
  },
  handleCast: (req, n) => {
    const [op, by] = req as Tuple;
    return op === atom("add") ? n + (by as number) : n;
  },
});

test("call and cast from JS", async () => {
  const pid = await Counter.start(node, { name: "CounterA", args: 10 });
  expect(pid).toBeInstanceOf(Pid);
  expect(await node.call(["CounterA", JS], atom("inc"))).toBe(11);
  await node.send(["CounterA", JS], tuple(atom("$gen_cast"), tuple(atom("add"), 5)));
  expect(await node.call(["CounterA", JS], atom("get"))).toBe(16);
  await node.exit(pid, atom("shutdown"));
});

test("call and cast from Elixir, two instances of one definition", async () => {
  await Counter.start(node, { name: "CounterB", args: 0 });
  await Counter.start(node, { name: "CounterC", args: 100 });
  const b = tuple(atom("Elixir.CounterB"), atom(JS));
  const c = tuple(atom("Elixir.CounterC"), atom(JS));
  await elixir("cast", [b, tuple(atom("add"), 2)]);
  expect(await elixir("call", [b, atom("inc")])).toBe(3);
  expect(await elixir("call", [c, atom("inc")])).toBe(101);
  await node.exit(node.whereis("CounterB")!, atom("shutdown"));
  await node.exit(node.whereis("CounterC")!, atom("shutdown"));
});

test("async init, handleInfo and terminate", async () => {
  const events: string[] = [];
  const Rates = defineGenServer({
    init: async (self) => {
      await Bun.sleep(20);
      return { rates: { EUR: 1.1 } as Record<string, number>, timer: setInterval(() => {}, 1000), self: self.pid };
    },
    handleCall: (req, s) => {
      const [op, cur] = req as Tuple;
      if (op === atom("get")) return { reply: s.rates[toJS<string>(cur!)] ?? null, state: s };
    },
    handleInfo: (msg, s) => {
      if (msg === atom("refresh")) return { ...s, rates: { ...s.rates, EUR: 1.2 } };
      return s;
    },
    terminate: (reason, s) => {
      clearInterval(s.timer);
      events.push(`terminate ${String(reason)}`);
    },
  });
  const started = Date.now();
  const pid = await Rates.start(node, { name: "Rates" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(15); // resolved after init
  expect(await node.call(["Rates", JS], tuple(atom("get"), "EUR"))).toBe(1.1);
  await node.send(pid, atom("refresh"));
  expect(await node.call(["Rates", JS], tuple(atom("get"), "EUR"))).toBe(1.2);
  expect(await node.call(["Rates", JS], tuple(atom("get"), "USD"))).toBe(atom("nil"));
  await node.exit(pid, atom("kill"));
  await Bun.sleep(20);
  expect(events).toEqual(["terminate killed"]);
});

test("a failing init rejects start and is not restarted", async () => {
  let inits = 0;
  const Broken = defineGenServer({
    init: () => {
      inits++;
      throw new Error("no config");
    },
  });
  await expect(Broken.start(node, { name: "Broken", restart: { delay: 10 } })).rejects.toThrow("no config");
  await Bun.sleep(50);
  expect(inits).toBe(1);
  expect(node.whereis("Broken")).toBeUndefined();
});

test("an unhandled call crashes the server; restart runs init again", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  let inits = 0;
  const Strict = defineGenServer({
    init: () => ++inits,
    handleCall: (req, n) => (req === atom("ping") ? { reply: atom("pong"), state: n } : undefined),
  });
  await Strict.start(node, { name: "Strict", restart: { delay: 10 } });
  const err = await node.call(["Strict", JS], atom("unknown")).catch((e) => e);
  expect(err).toBeInstanceOf(CallError);
  expect(((err as CallError).reason as Tuple).at(0)).toBe(atom("js_error"));
  await Bun.sleep(50);
  expect(inits).toBe(2);
  expect(await node.call(["Strict", JS], atom("ping"))).toBe(atom("pong"));
  expect(log).toHaveBeenCalledTimes(1);
  expect(String(log.mock.calls[0]![1])).toContain("no handleCall clause for unknown");
  log.mockRestore();
  await node.exit(node.whereis("Strict")!, atom("shutdown"));
});

test("a callback that forgets to return the state crashes with a clear error", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const Forgetful = defineGenServer({
    init: () => ({ n: 0 }),
    handleCast: (_req, s) => {
      s.n++;
      return undefined as unknown as typeof s; // forgot `return s`
    },
  });
  const pid = await Forgetful.start(node);
  await node.send(pid, tuple(atom("$gen_cast"), atom("bump")));
  await Bun.sleep(20);
  expect(String(log.mock.calls[0]![1])).toContain("handleCast must return the new state");
  log.mockRestore();
});

test("messages without handleInfo are logged and dropped", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const pid = await Counter.start(node, { args: 0 });
  await node.send(pid, atom("stray"));
  await Bun.sleep(20);
  expect(String(log.mock.calls[0]![0])).toContain("dropped stray");
  log.mockRestore();
  await node.exit(pid, atom("shutdown"));
});
