import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { atom, type ErlNode, type Pid, type Process, start, type Term, type Tuple, tuple } from "../src/index.ts";
import { COOKIE, inbox, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;
let node: ErlNode;

beforeAll(async () => {
  remote = await startNode("proc_test");
  node = start({ name: "proc_js@localhost", cookie: COOKIE });
  await node.connect(remote.name);
});

afterAll(async () => {
  await node.close();
  await remote.stop();
});

const sleeper = async () => (await node.rpc(remote.name, "Elixir.Helpers", "sleeper")) as Pid;
const alive = (pid: Pid) => node.rpc(remote.name, "erlang", "is_process_alive", [pid]);

// Has an Elixir process monitor `pid` and report `{:down, reason}` to a fresh inbox.
async function watch(pid: Pid): Promise<Process> {
  const watcher = inbox(node);
  await node.rpc(remote.name, "Elixir.Helpers", "watch", [pid, watcher.pid]);
  await Bun.sleep(50);
  return watcher;
}

const downReason = async (watcher: Process): Promise<Term> => {
  const msg = await watcher.receive(undefined, 2000);
  watcher.exit();
  return (msg as Tuple).at(1)!;
};

test("the body runs with its own pid and can talk to BEAM", async () => {
  const result = new Promise<Term>((resolve) => {
    node.spawn(async (self) => {
      await self.send(["echo", remote.name], tuple(self.pid, atom("hi")));
      resolve(await self.receive(undefined, 2000));
    });
  });
  expect(await result).toEqual(tuple(atom("echo"), atom("hi")));
});

test("a returning body exits with :normal", async () => {
  let release!: () => void;
  const pid = node.spawn(() => new Promise<void>((r) => (release = r)));
  const watcher = await watch(pid);
  release();
  expect(await downReason(watcher)).toBe(atom("normal"));
});

test("a throwing body exits with {:js_error, message} and is logged", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  let fail!: () => void;
  const pid = node.spawn(() => new Promise<void>((_, reject) => (fail = () => reject(new Error("boom")))));
  const watcher = await watch(pid);
  fail();
  expect(await downReason(watcher)).toEqual(tuple(atom("js_error"), new TextEncoder().encode("boom")));
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

test("without trapExit a linked process takes us down", async () => {
  const p = inbox(node);
  const remotePid = await sleeper();
  await p.link(remotePid);
  const watcher = await watch(p.pid);
  const pending = p.receive().catch((e: Error) => e.message);
  await node.rpc(remote.name, "erlang", "exit", [remotePid, atom("boom")]);
  expect(await downReason(watcher)).toBe(atom("boom"));
  expect(p.alive).toBe(false);
  expect(await pending).toBe("process exited");
});

test("without trapExit a normal exit of a linked process is ignored", async () => {
  const p = inbox(node);
  const { pid } = await p.spawnOn(remote.name, "timer", "sleep", [10], { link: true });
  await Bun.sleep(200);
  expect(await alive(pid)).toBe(false);
  expect(p.alive).toBe(true);
  p.exit();
});

test("our exit kills a linked BEAM process", async () => {
  const p = inbox(node);
  const remotePid = await sleeper();
  await p.link(remotePid);
  const watcher = await watch(remotePid);
  p.exit(atom("bye"));
  expect(await downReason(watcher)).toBe(atom("bye"));
});

test("exit(pid, :kill) cannot be trapped", async () => {
  const p = inbox(node);
  p.trapExit = true;
  const watcher = await watch(p.pid);
  await node.rpc(remote.name, "erlang", "exit", [p.pid, atom("kill")]);
  expect(await downReason(watcher)).toBe(atom("killed"));
});

test("node.exit sends exit signals to remote and local processes", async () => {
  const remotePid = await sleeper();
  const watcher = await watch(remotePid);
  await node.exit(remotePid, atom("stop"));
  expect(await downReason(watcher)).toBe(atom("stop"));

  const p = inbox(node);
  p.trapExit = true;
  await node.exit(p.pid, atom("hello"));
  expect(await p.receive(undefined, 1000)).toEqual(tuple(atom("EXIT"), node.pid, atom("hello")));
  await node.exit(p.pid, atom("kill"));
  expect(p.alive).toBe(false);
});

test("register and whereis", async () => {
  const pid = node.spawn((self) => {
    self.register("worker");
    return self.receive();
  });
  expect(node.whereis("worker")).toEqual(pid);
  await node.send("worker", atom("done"));
  await Bun.sleep(10);
  expect(node.whereis("worker")).toBeUndefined();
});

test("for await reads messages in order", async () => {
  const got: Term[] = [];
  const done = new Promise<void>((resolve) => {
    node.spawn(async (self) => {
      self.register("iter");
      for await (const msg of self) {
        got.push(msg);
        if (got.length === 3) break;
      }
      resolve();
    });
  });
  for (const n of [1, 2, 3]) await node.send("iter", n);
  await done;
  expect(got).toEqual([1, 2, 3]);
  await Bun.sleep(10); // the process exits right after its body returns
  expect(node.whereis("iter")).toBeUndefined();
});

test("for await ends quietly when the process is killed", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  let ended!: () => void;
  const finished = new Promise<void>((r) => (ended = r));
  const pid = node.spawn(async (self) => {
    for await (const _ of self) {
    }
    ended();
  });
  await node.exit(pid, atom("kill"));
  await finished;
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});
