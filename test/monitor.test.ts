import { afterAll, beforeAll, expect, test } from "bun:test";
import { atom, type ErlNode, Pid, Ref, start, TimeoutError, Tuple, tuple } from "../src/index.ts";
import { COOKIE, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;
let node: ErlNode;

beforeAll(async () => {
  remote = await startNode("mon_test");
  node = start({ name: "mon_js@localhost", cookie: COOKIE });
  await node.connect(remote.name);
});

afterAll(async () => {
  await node.close();
  await remote.stop();
});

const sleeper = async () => (await node.rpc(remote.name, "Elixir.Helpers", "sleeper")) as Pid;
const kill = (pid: Pid, reason = atom("boom")) => node.rpc(remote.name, "erlang", "exit", [pid, reason]);
const alive = (pid: Pid) => node.rpc(remote.name, "erlang", "is_process_alive", [pid]);

test("monitor a pid", async () => {
  const mb = node.spawnMailbox();
  const pid = await sleeper();
  const ref = await mb.monitor(pid);
  await kill(pid);
  expect(await mb.receive(undefined, 2000)).toEqual(tuple(atom("DOWN"), ref, atom("process"), pid, atom("boom")));
  mb.close();
});

test("monitor a registered name", async () => {
  const mb = node.spawnMailbox();
  const pid = await sleeper();
  await node.rpc(remote.name, "erlang", "register", [atom("named_sleeper"), pid]);
  const ref = await mb.monitor(["named_sleeper", remote.name]);
  await kill(pid);
  const object = tuple(atom("named_sleeper"), atom(remote.name));
  expect(await mb.receive(undefined, 2000)).toEqual(tuple(atom("DOWN"), ref, atom("process"), object, atom("boom")));
  mb.close();
});

test("monitor a missing process", async () => {
  const mb = node.spawnMailbox();
  const ref = await mb.monitor(["nobody", remote.name]);
  const down = (await mb.receive(undefined, 2000)) as Tuple;
  expect(down.at(1)).toEqual(ref);
  expect(down.at(4)).toBe(atom("noproc"));
  mb.close();
});

test("demonitor", async () => {
  const mb = node.spawnMailbox();
  const pid = await sleeper();
  const ref = await mb.monitor(pid);
  mb.demonitor(ref);
  await kill(pid);
  await expect(mb.receive(undefined, 300)).rejects.toBeInstanceOf(TimeoutError);
  mb.close();
});

test("link: remote exit arrives as a message", async () => {
  const mb = node.spawnMailbox();
  const pid = await sleeper();
  await mb.link(pid);
  await kill(pid);
  expect(await mb.receive(undefined, 2000)).toEqual(tuple(atom("EXIT"), pid, atom("boom")));
  mb.close();
});

test("link: closing the mailbox kills the linked process", async () => {
  const mb = node.spawnMailbox();
  const watcher = node.spawnMailbox();
  const pid = await sleeper();
  await mb.link(pid);
  await node.rpc(remote.name, "Elixir.Helpers", "watch", [pid, watcher.pid]);
  mb.close(atom("bye"));
  expect(await watcher.receive(undefined, 2000)).toEqual(tuple(atom("down"), atom("bye")));
  watcher.close();
});

test("link from the remote side", async () => {
  const mb = node.spawnMailbox();
  const watcher = node.spawnMailbox();
  const linker = (await node.rpc(remote.name, "Elixir.Helpers", "linker", [mb.pid])) as Pid;
  await node.rpc(remote.name, "Elixir.Helpers", "watch", [linker, watcher.pid]);
  await Bun.sleep(100);
  mb.close(atom("bye"));
  expect(await watcher.receive(undefined, 2000)).toEqual(tuple(atom("down"), atom("bye")));
  watcher.close();
});

test("unlink from our side", async () => {
  const mb = node.spawnMailbox();
  const pid = await sleeper();
  await mb.link(pid);
  await Bun.sleep(100);
  const links = () => node.rpc(remote.name, "erlang", "process_info", [pid, atom("links")]);
  expect(await links()).toEqual(tuple(atom("links"), [mb.pid]));
  await mb.unlink(pid);
  await Bun.sleep(100);
  expect(await links()).toEqual(tuple(atom("links"), []));
  await kill(pid);
  await expect(mb.receive(undefined, 300)).rejects.toBeInstanceOf(TimeoutError);
  mb.close();
});

test("unlink from the remote side", async () => {
  const mb = node.spawnMailbox();
  const linker = (await node.rpc(remote.name, "Elixir.Helpers", "linker", [mb.pid])) as Pid;
  await Bun.sleep(100);
  await node.send(linker, atom("unlink"));
  await Bun.sleep(100);
  // Relinking only works once the remote got our UNLINK_ID_ACK.
  const links = () => node.rpc(remote.name, "erlang", "process_info", [linker, atom("links")]);
  await mb.link(linker);
  await Bun.sleep(100);
  expect(await links()).toEqual(tuple(atom("links"), [mb.pid]));
  await mb.unlink(linker);
  await Bun.sleep(100);
  mb.close(atom("bye"));
  await Bun.sleep(100);
  expect(await alive(linker)).toBe(true);
  await kill(linker);
});

test("remote monitor of our mailbox", async () => {
  const mb = node.spawnMailbox();
  const watcher = node.spawnMailbox();
  await node.rpc(remote.name, "Elixir.Helpers", "watch", [mb.pid, watcher.pid]);
  await Bun.sleep(100);
  mb.close(atom("done"));
  expect(await watcher.receive(undefined, 2000)).toEqual(tuple(atom("down"), atom("done")));

  // A closed mailbox looks like a dead process.
  await node.rpc(remote.name, "Elixir.Helpers", "watch", [mb.pid, watcher.pid]);
  expect(await watcher.receive(undefined, 2000)).toEqual(tuple(atom("down"), atom("noproc")));
  watcher.close();
});

test("exit/2 from the remote side arrives as a message", async () => {
  const mb = node.spawnMailbox();
  await kill(mb.pid, atom("hello"));
  const msg = (await mb.receive(undefined, 2000)) as Tuple;
  expect(msg.at(0)).toBe(atom("EXIT"));
  expect(msg.at(1)).toBeInstanceOf(Pid);
  expect(msg.at(2)).toBe(atom("hello"));
  mb.close();
});

test("lost connection: noconnection for monitors and links, call fails", async () => {
  const other = await startNode("mon_other");
  const n = start({ name: "mon_js2@localhost", cookie: COOKIE });
  const mb = n.spawnMailbox();
  const pid = (await n.rpc(other.name, "Elixir.Helpers", "sleeper")) as Pid;
  const ref = await mb.monitor(pid);
  await mb.link(pid);
  const pending = n.call(["echo", other.name], atom("never_replied"), 10_000).catch((e) => e);
  await Bun.sleep(100);
  await other.stop();
  expect(await mb.receive((m) => m instanceof Tuple && m.at(0) === atom("DOWN"), 5000)).toEqual(
    tuple(atom("DOWN"), ref, atom("process"), pid, atom("noconnection")),
  );
  expect(await mb.receive(undefined, 2000)).toEqual(tuple(atom("EXIT"), pid, atom("noconnection")));
  expect((await pending).reason).toBe(atom("noconnection"));
  expect(ref).toBeInstanceOf(Ref);
  await n.close();
}, 20_000);
