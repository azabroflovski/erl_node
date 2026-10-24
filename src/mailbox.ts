import { Atom, atom, Pid, Ref, type Term, Tuple, tuple } from "./etf.ts";
import type { ErlNode } from "./node.ts";

export class TimeoutError extends Error {}

type Waiter = {
  match: (msg: Term) => boolean;
  resolve: (msg: Term) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** @internal */
export const pidKey = (p: Pid): string => `${p.node.name}/${p.id}/${p.serial}/${p.creation}`;
/** @internal */
export const refKey = (r: Ref): string => `${r.node.name}/${r.creation}/${r.ids.join(".")}`;

const DOWN = atom("DOWN");
const EXIT = atom("EXIT");

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

  /** @internal Linked pids; `unlinking` holds the id of a pending UNLINK_ID. */
  readonly links = new Map<string, { pid: Pid; unlinking?: number }>();
  /** @internal Monitors this mailbox owns. */
  readonly monitors = new Map<string, { ref: Ref; target: Pid | Atom; node: string }>();
  /** @internal Remote processes monitoring this mailbox. */
  readonly monitoredBy = new Map<string, { ref: Ref; pid: Pid; proc: Pid | Atom }>();

  constructor(
    readonly pid: Pid,
    private node: ErlNode,
  ) {}

  /** @internal */
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
  send(to: Pid | string, msg: Term, node?: string): Promise<void> {
    return this.node.send(to, msg, { node, from: this.pid });
  }

  /** Links to `pid`. If its node cannot be reached, `{:EXIT, pid, :noconnection}` arrives. */
  async link(pid: Pid): Promise<void> {
    this.ensureOpen();
    const key = pidKey(pid);
    const existing = this.links.get(key);
    if (existing && existing.unlinking === undefined) return;
    this.links.set(key, { pid });
    const conn = await this.node.connectOrNull(pid.node.name);
    if (!conn) {
      this.links.delete(key);
      this.deliver(tuple(EXIT, pid, atom("noconnection")));
      return;
    }
    this.node.sendControl(conn, tuple(1, this.pid, pid));
  }

  /** Removes the link to `pid`. Exit signals from it are ignored from now on. */
  async unlink(pid: Pid): Promise<void> {
    const key = pidKey(pid);
    const link = this.links.get(key);
    if (!link || link.unlinking !== undefined) return;
    const conn = this.node.connectionNow(pid.node.name);
    if (!conn) {
      this.links.delete(key);
      return;
    }
    link.unlinking = this.node.nextUnlinkId();
    this.node.sendControl(conn, tuple(35, link.unlinking, this.pid, pid));
  }

  /**
   * Monitors a pid, or a name registered on `node` (default: the node passed
   * to `connect`). Resolves with the monitor reference.
   */
  async monitor(target: Pid | string, node?: string): Promise<Ref> {
    this.ensureOpen();
    const ref = this.node.makeRef();
    const proc = typeof target === "string" ? atom(target) : target;
    const nodeName = proc instanceof Pid ? proc.node.name : (node ?? this.node.remote);
    if (!nodeName) throw new Error("no node given for a registered name");
    const conn = await this.node.connectOrNull(nodeName);
    if (!conn) {
      this.deliver(tuple(DOWN, ref, atom("process"), downObject(proc, nodeName), atom("noconnection")));
      return ref;
    }
    this.monitors.set(refKey(ref), { ref, target: proc, node: nodeName });
    this.node.sendControl(conn, tuple(19, this.pid, proc, ref));
    return ref;
  }

  /** Removes a monitor and drops its `:DOWN` message if one already arrived. */
  demonitor(ref: Ref) {
    const key = refKey(ref);
    const mon = this.monitors.get(key);
    this.queue = this.queue.filter((m) => !isDown(m, ref));
    if (!mon) return;
    this.monitors.delete(key);
    const conn = this.node.connectionNow(mon.node);
    if (conn) this.node.sendControl(conn, tuple(20, this.pid, mon.target, ref));
  }

  /**
   * Closes the mailbox as if the process exited with `reason`: linked and
   * monitoring processes get exit signals, own monitors are removed, pending
   * `receive` calls are rejected.
   */
  close(reason: Term = atom("normal")) {
    if (this.closed) return;
    for (const ref of [...this.monitors.values()].map((m) => m.ref)) this.demonitor(ref);
    for (const { pid, unlinking } of this.links.values()) {
      if (unlinking !== undefined) continue;
      const conn = this.node.connectionNow(pid.node.name);
      if (conn) this.node.sendExit(conn, this.pid, pid, reason);
    }
    for (const { ref, pid, proc } of this.monitoredBy.values()) {
      const conn = this.node.connectionNow(pid.node.name);
      if (conn) this.node.sendMonitorExit(conn, proc, pid, ref, reason);
    }
    this.links.clear();
    this.monitoredBy.clear();
    this.closed = true;
    this.node.unregister(this);
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("mailbox closed"));
    }
  }

  private ensureOpen() {
    if (this.closed) throw new Error("mailbox closed");
  }

  // Signals routed here by the node.

  /** @internal An exit signal over a link. */
  linkExit(from: Pid, reason: Term) {
    const key = pidKey(from);
    const link = this.links.get(key);
    if (!link || link.unlinking !== undefined) return;
    this.links.delete(key);
    this.deliver(tuple(EXIT, from, reason));
  }

  /** @internal */
  monitorDown(ref: Ref, reason: Term) {
    const key = refKey(ref);
    const mon = this.monitors.get(key);
    if (!mon) return;
    this.monitors.delete(key);
    this.deliver(tuple(DOWN, ref, atom("process"), downObject(mon.target, mon.node), reason));
  }

  /** @internal The connection to `peer` is gone. */
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
  }
}

function downObject(target: Pid | Atom, node: string): Term {
  return target instanceof Pid ? target : tuple(target, atom(node));
}

/** True for a `{:DOWN, ref, ...}` message of the given monitor. */
export function isDown(msg: Term, ref: Ref): msg is Tuple {
  return msg instanceof Tuple && msg.length === 5 && msg.at(0) === DOWN && ref.equals(msg.at(1));
}
