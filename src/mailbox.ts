import { OP } from "./connection.ts";
import { DFLAG } from "./handshake.ts";
import { Atom, atom, format, Pid, Ref, type Term, Tuple, tuple } from "./etf.ts";
import type { Connection } from "./connection.ts";
import type { Dest, ErlNode } from "./node.ts";

export class TimeoutError extends Error {}

const DOWN = atom("DOWN");
const EXIT = atom("EXIT");

/** A `spawn` request failed on the remote node, e.g. with `badopt` or `noconnection`. */
export class SpawnError extends Error {
  constructor(readonly reason: Term) {
    super(`spawn failed: ${format(reason)}`);
  }
}

export interface Spawned {
  pid: Pid;
  /** The monitor reference, when spawned with `monitor: true`. */
  ref?: Ref;
}

type PendingSpawn = {
  node: string;
  resolve: (s: Spawned) => void;
  reject: (err: Error) => void;
};

type Waiter = {
  match: (msg: Term) => boolean;
  resolve: (msg: Term) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

let nextUnlinkId = 1;

/**
 * A process-like mailbox owned by the JS node, addressable by its pid.
 *
 * It behaves like a process that traps exits: exit signals from linked
 * processes and from `exit/2` arrive as `{:EXIT, from, reason}` messages,
 * monitors deliver `{:DOWN, ref, :process, object, reason}`.
 */
export class Mailbox {
  private queue: Term[] = [];
  private waiters: Waiter[] = [];
  closed = false;

  // The fields below are kept up to date by ErlNode as signals arrive.
  /** Linked pids by key; `unlinking` holds the id of a pending UNLINK_ID. */
  readonly links = new Map<string, { pid: Pid; unlinking?: number }>();
  /** Monitors this mailbox owns, by ref key. */
  readonly monitors = new Map<string, { ref: Ref; target: Pid | Atom; node: string }>();
  /** Remote processes monitoring this mailbox, by ref key. */
  readonly monitoredBy = new Map<string, { ref: Ref; pid: Pid; proc: Pid | Atom }>();
  /** Spawn requests waiting for SPAWN_REPLY, by request id key. */
  readonly spawns = new Map<string, PendingSpawn>();

  constructor(
    readonly pid: Pid,
    private node: ErlNode,
  ) {}

  /** Puts a message into the mailbox. */
  deliver(msg: Term) {
    if (this.closed) return;
    const i = this.waiters.findIndex((w) => w.match(msg));
    if (i === -1) {
      this.queue.push(msg);
      return;
    }
    const [w] = this.waiters.splice(i, 1);
    clearTimeout(w!.timer);
    w!.resolve(msg);
  }

  /** Takes the first message that satisfies `match`, waiting up to `timeout` ms for one. */
  receive(match: (msg: Term) => boolean = () => true, timeout = Infinity): Promise<Term> {
    if (this.closed) return Promise.reject(new Error("mailbox closed"));
    const i = this.queue.findIndex(match);
    if (i !== -1) return Promise.resolve(this.queue.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const w: Waiter = { match, resolve, reject };
      if (Number.isFinite(timeout)) {
        w.timer = setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new TimeoutError(`no message within ${timeout} ms`));
        }, timeout);
      }
      this.waiters.push(w);
    });
  }

  /** Registers this mailbox under `name` on its node. */
  register(name: string) {
    this.node.register(name, this);
  }

  /** Sends `msg` with this mailbox's pid as the sender. */
  send(to: Dest, msg: Term): Promise<void> {
    return this.node.send(to, msg, this.pid);
  }

  /** Links to `pid`. If its node cannot be reached, `{:EXIT, pid, :noconnection}` arrives. */
  async link(pid: Pid): Promise<void> {
    if (this.closed) throw new Error("mailbox closed");
    const existing = this.links.get(pid.key);
    if (existing && existing.unlinking === undefined) return;
    this.links.set(pid.key, { pid });
    const conn = await reach(this.node, pid.node.name);
    if (!conn) {
      this.links.delete(pid.key);
      this.deliver(tuple(EXIT, pid, atom("noconnection")));
      return;
    }
    conn.trySend(tuple(OP.LINK, this.pid, pid));
  }

  /** Removes the link to `pid`. Exit signals from it are ignored from now on. */
  async unlink(pid: Pid): Promise<void> {
    const link = this.links.get(pid.key);
    if (!link || link.unlinking !== undefined) return;
    const conn = this.node.connection(pid.node.name);
    if (!conn) {
      this.links.delete(pid.key);
      return;
    }
    link.unlinking = nextUnlinkId++;
    conn.trySend(tuple(OP.UNLINK_ID, link.unlinking, this.pid, pid));
  }

  /**
   * Monitors a pid or `[name, node]`, like `Process.monitor/1`. Resolves with
   * the monitor reference.
   */
  async monitor(target: Pid | [name: string, node: string]): Promise<Ref> {
    if (this.closed) throw new Error("mailbox closed");
    const ref = this.node.makeRef();
    const proc = target instanceof Pid ? target : atom(target[0]);
    const nodeName = target instanceof Pid ? target.node.name : target[1];
    const conn = await reach(this.node, nodeName);
    if (!conn) {
      this.deliver(tuple(DOWN, ref, atom("process"), downObject(proc, nodeName), atom("noconnection")));
      return ref;
    }
    this.monitors.set(ref.key, { ref, target: proc, node: nodeName });
    conn.trySend(tuple(OP.MONITOR_P, this.pid, proc, ref));
    return ref;
  }

  /**
   * Starts `m.f(...args)` on `node` with this mailbox as the parent, like
   * `spawn_opt/4` with `link` and `monitor`. Resolves once the remote node
   * has started the process. The monitor reference is the request id, as in
   * `erlang:spawn_request/5`.
   */
  async spawn(
    node: string,
    m: string,
    f: string,
    args: Term[] = [],
    opts: { link?: boolean; monitor?: boolean } = {},
  ): Promise<Spawned> {
    if (this.closed) throw new Error("mailbox closed");
    const conn = await reach(this.node, node);
    if (!conn) throw new SpawnError(atom("noconnection"));
    if (!(conn.peerFlags & DFLAG.SPAWN)) throw new SpawnError(atom("notsup"));
    const reqId = this.node.makeRef();
    const options: Term[] = [];
    if (opts.link) options.push(atom("link"));
    if (opts.monitor) options.push(atom("monitor"));
    const mfa = tuple(atom(m), atom(f), args.length);
    return new Promise((resolve, reject) => {
      this.spawns.set(reqId.key, { node, resolve, reject });
      conn.trySend(tuple(OP.SPAWN_REQUEST, reqId, this.pid, this.node.groupLeaderPid(), mfa, options), args);
    });
  }

  /** The remote node answered a spawn request. Flags: 1 = linked, 2 = monitored. */
  spawnReply(reqId: Ref, flags: number, result: Term) {
    const pending = this.spawns.get(reqId.key);
    if (!pending) return;
    this.spawns.delete(reqId.key);
    if (!(result instanceof Pid)) return pending.reject(new SpawnError(result));
    if (flags & 1) this.links.set(result.key, { pid: result });
    if (flags & 2) this.monitors.set(reqId.key, { ref: reqId, target: result, node: pending.node });
    pending.resolve(flags & 2 ? { pid: result, ref: reqId } : { pid: result });
  }

  /** Removes a monitor and drops its `:DOWN` message if one already arrived. */
  demonitor(ref: Ref) {
    const mon = this.monitors.get(ref.key);
    this.queue = this.queue.filter((m) => !isDown(m, ref));
    if (!mon) return;
    this.monitors.delete(ref.key);
    this.node.connection(mon.node)?.trySend(tuple(OP.DEMONITOR_P, this.pid, mon.target, ref));
  }

  /**
   * Closes the mailbox as if the process exited with `reason`: linked and
   * monitoring processes get exit signals, own monitors are removed, pending
   * `receive` calls are rejected.
   */
  close(reason: Term = atom("normal")) {
    if (this.closed) return;
    for (const { ref } of [...this.monitors.values()]) this.demonitor(ref);
    for (const { pid, unlinking } of this.links.values()) {
      if (unlinking === undefined) this.node.connection(pid.node.name)?.exit(this.pid, pid, reason);
    }
    for (const { ref, pid, proc } of this.monitoredBy.values()) {
      this.node.connection(pid.node.name)?.monitorExit(proc, pid, ref, reason);
    }
    this.links.clear();
    this.monitoredBy.clear();
    for (const { reject } of this.spawns.values()) reject(new Error("mailbox closed"));
    this.spawns.clear();
    this.closed = true;
    this.node.drop(this);
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("mailbox closed"));
    }
  }

  /** An exit signal arrived over the link with `from`. */
  linkExit(from: Pid, reason: Term) {
    const link = this.links.get(from.key);
    if (!link || link.unlinking !== undefined) return;
    this.links.delete(from.key);
    this.deliver(tuple(EXIT, from, reason));
  }

  /** A monitored process went away. */
  monitorDown(ref: Ref, reason: Term) {
    const mon = this.monitors.get(ref.key);
    if (!mon) return;
    this.monitors.delete(ref.key);
    this.deliver(tuple(DOWN, ref, atom("process"), downObject(mon.target, mon.node), reason));
  }

  /** The connection to `peer` is gone: links and monitors over it fire with `:noconnection`. */
  connectionLost(peer: string) {
    const noconnection = atom("noconnection");
    for (const [key, { pid, unlinking }] of this.links) {
      if (pid.node.name !== peer) continue;
      this.links.delete(key);
      if (unlinking === undefined) this.deliver(tuple(EXIT, pid, noconnection));
    }
    for (const mon of [...this.monitors.values()]) {
      if (mon.node === peer) this.monitorDown(mon.ref, noconnection);
    }
    for (const [key, { pid }] of this.monitoredBy) {
      if (pid.node.name === peer) this.monitoredBy.delete(key);
    }
    for (const [key, { node, reject }] of this.spawns) {
      if (node !== peer) continue;
      this.spawns.delete(key);
      reject(new SpawnError(noconnection));
    }
  }
}

/** The connection to `name`, or undefined if it cannot be established. */
async function reach(node: ErlNode, name: string): Promise<Connection | undefined> {
  try {
    await node.connect(name);
  } catch {
    return undefined;
  }
  return node.connection(name);
}

function downObject(target: Pid | Atom, node: string): Term {
  return target instanceof Pid ? target : tuple(target, atom(node));
}

/** True for a `{:DOWN, ref, ...}` message of the given monitor. */
export function isDown(msg: Term, ref: Ref): msg is Tuple {
  return msg instanceof Tuple && msg.length === 5 && msg.at(0) === DOWN && ref.equals(msg.at(1));
}
