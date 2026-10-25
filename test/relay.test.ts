import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { atom, type ErlNode, Pid, RelayError, start, type Term, Tuple, tuple } from "../src/index.ts";
import { COOKIE, inbox, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;
let node: ErlNode;

beforeAll(async () => {
  remote = await startNode("relay_test");
  node = start({ name: "relay_js@localhost", cookie: COOKIE });
  await node.connect(remote.name);
});

afterAll(async () => {
  await node.close();
  await remote.stop();
});

const helper = (f: string, args: Term[]) => node.rpc(remote.name, "Elixir.Helpers", f, args);
const registered = (key: string) => helper("registry_count", [key]);
const register = (key: string): [string, string, Term[]] => [
  "Elixir.Registry",
  "register",
  [atom("Elixir.TestRegistry"), key, atom("nil")],
];

async function eventually(check: () => Promise<boolean>, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

test("relay through Registry: broadcasts reach the JS process", async () => {
  const p = inbox(node);
  const { result } = await p.relay(remote.name, ...register("orders"));
  expect((result as Tuple).at(0)).toBe(atom("ok"));
  expect(await registered("orders")).toBe(1);
  await helper("registry_broadcast", ["orders", tuple(atom("order"), 1)]);
  await helper("registry_broadcast", ["orders", tuple(atom("order"), 2)]);
  const got: Term[] = [];
  for await (const msg of p) {
    got.push(msg);
    if (got.length === 2) break;
  }
  expect(got).toEqual([tuple(atom("order"), 1), tuple(atom("order"), 2)]);
  p.exit();
});

test("relay through :pg with $self", async () => {
  const p = inbox(node);
  const { result } = await p.relay(remote.name, "pg", "join", [atom("test_pg"), "workers", atom("$self")]);
  expect(result).toBe(atom("ok"));
  await helper("pg_broadcast", ["workers", atom("job")]);
  expect(await p.receive(undefined, 2000)).toBe(atom("job"));
  p.exit();
});

test("the subscription goes away when the JS process exits", async () => {
  const p = inbox(node);
  await p.relay(remote.name, ...register("gone"));
  expect(await registered("gone")).toBe(1);
  p.exit();
  await eventually(async () => (await registered("gone")) === 0);
});

test("stop() ends the relay and keeps the process", async () => {
  const p = inbox(node);
  const { pid, stop } = await p.relay(remote.name, ...register("stopped"));
  await stop();
  await eventually(async () => (await registered("stopped")) === 0);
  expect(await node.rpc(remote.name, "erlang", "is_process_alive", [pid])).toBe(false);
  expect(p.alive).toBe(true);
  await node.send(p.pid, atom("still_here"));
  expect(await p.receive(undefined, 1000)).toBe(atom("still_here"));
  p.exit();
});

test("a dead relay takes the JS process down, or arrives as EXIT with trapExit", async () => {
  const p = inbox(node);
  const { pid } = await p.relay(remote.name, ...register("killed"));
  await node.rpc(remote.name, "erlang", "exit", [pid, atom("boom")]);
  await eventually(async () => !p.alive);

  const t = inbox(node);
  t.trapExit = true;
  const relay = await t.relay(remote.name, ...register("trapped"));
  await node.rpc(remote.name, "erlang", "exit", [relay.pid, atom("boom")]);
  expect(await t.receive(undefined, 2000)).toEqual(tuple(atom("EXIT"), relay.pid, atom("boom")));
  t.exit();
});

test("a failing subscribe call rejects with RelayError", async () => {
  const p = inbox(node);
  const err = await p.relay(remote.name, "erlang", "error", [atom("boom")]).catch((e) => e);
  expect(err).toBeInstanceOf(RelayError);
  expect((err.reason as Tuple).at(0)).toBe(atom("boom"));
  expect(p.alive).toBe(true);
  p.exit();
});

test("relay pid lives on the remote node", async () => {
  const p = inbox(node);
  const { pid } = await p.relay(remote.name, ...register("where"));
  expect(pid).toBeInstanceOf(Pid);
  expect(pid.node).toBe(atom(remote.name));
  p.exit();
});

test("a body that relays and reads with for await", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const got = new Promise<Term>((resolve) => {
    node.spawn(async (self) => {
      await self.relay(remote.name, ...register("body"));
      for await (const msg of self) return resolve(msg);
    });
  });
  await eventually(async () => (await registered("body")) === 1);
  await helper("registry_broadcast", ["body", atom("hello")]);
  expect(await got).toBe(atom("hello"));
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});

test("the subscription goes away when the connection drops", async () => {
  const other = start({ name: "relay_js2@localhost", cookie: COOKIE });
  const p = inbox(other);
  await p.relay(remote.name, ...register("dropped"));
  expect(await registered("dropped")).toBe(1);
  other.disconnect(remote.name);
  await eventually(async () => (await registered("dropped")) === 0);
  await other.close();
});
