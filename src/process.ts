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
 * A process on the JS node: a pid with a mailbox, started by `node.spawn`.
 * It lives while its function runs, and exits like an Erlang process:
 * linked processes get exit signals, monitors fire with `:DOWN`.
 *
 * Exit signals follow Erlang: without `trapExit` a non-normal exit signal
 * kills the process; with it, signals arrive as `{:EXIT, from, reason}`
 * messages. `exit(pid, :kill)` cannot be trapped.
 */
export class Process {
  private queue: Term[] = [];
  private waiters: Waiter[] = [];
  alive = true;
  /** `Process.flag(:trap_exit, true)`: turn exit signals into messages. */
  trapExit = false;

  // The fields below are kept up to date by ErlNode as signals arrive.
  /** Linked pids by key; `unlinking` holds the id of a pending UNLINK_ID. */
  readonly links = new Map<string, { pid: Pid; unlinking?: number }>();
  /** Monitors this process owns, by ref key. */
  readonly monitors = new Map<string, { ref: Ref; target: Pid | Atom; node: string; local?: Process }>();
  /** Remote processes monitoring this process, by ref key. */
  readonly monitoredBy = new Map<string, { ref: Ref; pid: Pid; proc: Pid | Atom }>();
  /** Spawn requests waiting for SPAWN_REPLY, by request id key. */
  readonly spawns = new Map<string, PendingSpawn>();

  constructor(
    readonly pid: Pid,
    private node: ErlNode,
  ) {}

  /** Puts a message into the mailbox. */
  deliver(msg: Term) {
    if (!this.alive) return;
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
    if (!this.alive) return Promise.reject(new Error("process exited"));
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

  /**
   * Every incoming message, in order: `for await (const msg of self)`.
   * The loop ends when the process exits.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<Term> {
    while (this.alive) {
      try {
        yield await this.receive();
      } catch (err) {
        if (!this.alive) return;
        throw err;
      }
    }
  }

  /** Registers this process under `name` on its node, like `Process.register/2`. */
  register(name: string) {
    this.node.register(name, this);
  }

  /** Sends `msg` with this process as the sender. */
  send(to: Dest, msg: Term): Promise<void> {
    return this.node.send(to, msg, this.pid);
  }

  /** Links to `pid`. If its node cannot be reached, `{:EXIT, pid, :noconnection}` arrives. */
  async link(pid: Pid): Promise<void> {
    if (!this.alive) throw new Error("process exited");
    if (pid.equals(this.pid)) return;
    const existing = this.links.get(pid.key);
    if (existing && existing.unlinking === undefined) return;
    if (pid.node === this.node.name) {
      const other = this.node.lookup(pid);
      if (!other) return this.exitSignal(pid, atom("noproc"), false);
      this.links.set(pid.key, { pid });
      other.links.set(this.pid.key, { pid: this.pid });
      return;
    }
    this.links.set(pid.key, { pid });
    const conn = await reach(this.node, pid.node.name);
    if (!conn) {
      this.links.delete(pid.key);
      this.exitSignal(pid, atom("noconnection"), false);
      return;
    }
    conn.trySend(tuple(OP.LINK, this.pid, pid));
  }

  /** Removes the link to `pid`. Exit signals from it are ignored from now on. */
  async unlink(pid: Pid): Promise<void> {
    const link = this.links.get(pid.key);
    if (!link || link.unlinking !== undefined) return;
    if (pid.node === this.node.name) {
      this.links.delete(pid.key);
      this.node.lookup(pid)?.links.delete(this.pid.key);
      return;
    }
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
    if (!this.alive) throw new Error("process exited");
    const ref = this.node.makeRef();
    const proc = target instanceof Pid ? target : atom(target[0]);
    const nodeName = target instanceof Pid ? target.node.name : target[1];
    if (nodeName === this.node.name.name) {
      const other = this.node.lookup(target instanceof Pid ? target : target[0]);
      if (!other) {
        this.deliver(tuple(DOWN, ref, atom("process"), downObject(proc, nodeName), atom("noproc")));
        return ref;
      }
      this.monitors.set(ref.key, { ref, target: proc, node: nodeName, local: other });
      other.monitoredBy.set(ref.key, { ref, pid: this.pid, proc });
      return ref;
    }
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
   * Starts `m.f(...args)` on `node` with this process as the parent, like
   * `Node.spawn/4` with `link` and `monitor` options. Resolves once the
   * remote node has started the process. The monitor reference is the
   * request id, as in `erlang:spawn_request/5`.
   */
  async spawnOn(
    node: string,
    m: string,
    f: string,
    args: Term[] = [],
    opts: { link?: boolean; monitor?: boolean } = {},
  ): Promise<Spawned> {
    if (!this.alive) throw new Error("process exited");
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

  /**
   * Starts a relay on `node`: a process that calls `m.f(...args)` and then
   * forwards every message it receives to this process. `m.f` is meant to
   * subscribe the relay somewhere, e.g. `Registry.register/3` or `:pg.join/3`;
   * the atom `$self` in `args` stands for the relay's own pid. Resolves with
   * what `m.f` returned once the call is done, so no message is missed after
   * that. Fails with `RelayError` if `m.f` raises.
   *
   * The relay is linked to this process and monitors it: when this process
   * exits, for any reason, the relay exits too and the subscription goes away
   * with it; if the relay dies, this process gets the exit signal. `stop()` ends the relay and keeps
   * this process running. No code needs to be deployed on `node`: the relay
   * runs through `erl_eval`.
   */
  async relay(
    node: string,
    m: string,
    f: string,
    args: Term[] = [],
    timeout = 5000,
  ): Promise<{ pid: Pid; result: Term; stop: () => Promise<void> }> {
    const ref = this.node.makeRef();
    const bindings = [
      tuple(atom("A"), args),
      tuple(atom("F"), atom(f)),
      tuple(atom("Js"), this.pid),
      tuple(atom("M"), atom(m)),
      tuple(atom("Ref"), ref),
    ];
    const exprs = await relayExprs(this.node, node);
    const { pid } = await this.spawnOn(node, "erl_eval", "exprs", [exprs, bindings], { link: true });
    const reply = (await this.receive(
      (msg) =>
        msg instanceof Tuple &&
        ((msg.at(0) === RELAY && ref.equals(msg.at(1))) || (msg.at(0) === EXIT && pid.equals(msg.at(1)))),
      timeout,
    )) as Tuple;
    // With trapExit a relay that died before reporting shows up as {:EXIT, pid, reason}.
    if (reply.at(0) === EXIT) throw new RelayError(reply.at(2)!);
    const [status, value] = (reply.at(2) as Tuple).elements;
    if (status !== atom("ok")) throw new RelayError(value!);
    const stop = async () => {
      await this.unlink(pid);
      await this.node.exit(pid, atom("kill"));
    };
    return { pid, result: value!, stop };
  }

  /**
   * Subscribes this process to a Phoenix.PubSub topic on `node`:
   * `self.subscribe(node, "Elixir.MyApp.PubSub", "orders")`. Broadcasts to the
   * topic arrive in the mailbox as they are. A relay under the hood, see `relay`.
   */
  async subscribe(node: string, pubsub: string, topic: string): Promise<{ stop: () => Promise<void> }> {
    const { stop } = await this.relay(node, "Elixir.Phoenix.PubSub", "subscribe", [atom(pubsub), topic]);
    return { stop };
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
    if (mon.local) mon.local.monitoredBy.delete(ref.key);
    else this.node.connection(mon.node)?.trySend(tuple(OP.DEMONITOR_P, this.pid, mon.target, ref));
  }

  /**
   * Ends the process with `reason`: linked and monitoring processes get exit
   * signals, own monitors are removed, pending and later `receive` calls fail.
   * The function passed to `spawn` should return after this.
   */
  exit(reason: Term = atom("normal")) {
    if (!this.alive) return;
    this.alive = false;
    for (const { ref } of [...this.monitors.values()]) this.demonitor(ref);
    // Signals to local processes are delivered after this exit completes,
    // as they would be asynchronous in Erlang.
    for (const { pid, unlinking } of this.links.values()) {
      if (unlinking !== undefined) continue;
      if (pid.node === this.node.name) queueMicrotask(() => this.node.lookup(pid)?.linkExit(this.pid, reason));
      else this.node.connection(pid.node.name)?.exit(this.pid, pid, reason);
    }
    for (const { ref, pid, proc } of this.monitoredBy.values()) {
      if (pid.node === this.node.name) queueMicrotask(() => this.node.lookup(pid)?.monitorDown(ref, reason));
      else this.node.connection(pid.node.name)?.monitorExit(proc, pid, ref, reason);
    }
    this.links.clear();
    this.monitoredBy.clear();
    for (const { reject } of this.spawns.values()) reject(new Error("process exited"));
    this.spawns.clear();
    this.node.drop(this);
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("process exited"));
    }
  }

  /** An exit signal arrived over the link with `from`. */
  linkExit(from: Pid, reason: Term) {
    const link = this.links.get(from.key);
    if (!link || link.unlinking !== undefined) return;
    this.links.delete(from.key);
    this.exitSignal(from, reason, false);
  }

  /** An exit signal from `from`; `direct` for `exit/2`, where `:kill` cannot be trapped. */
  exitSignal(from: Pid, reason: Term, direct: boolean) {
    if (!this.alive) return;
    if (direct && reason === atom("kill")) return this.exit(atom("killed"));
    if (this.trapExit) return this.deliver(tuple(EXIT, from, reason));
    if (reason !== atom("normal")) this.exit(reason);
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
      if (unlinking === undefined) this.exitSignal(pid, noconnection, false);
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

/** The subscribing call of a relay raised; `reason` is the Erlang exit reason. */
export class RelayError extends Error {
  constructor(readonly reason: Term) {
    super(`relay call failed: ${format(reason)}`);
  }
}

const RELAY = atom("$erlnode_relay");

// Runs in erl_eval on the remote node with M, F, A, Js and Ref bound. Reports
// the call's outcome to Js, then forwards everything it receives to Js until
// Js goes away. The link alone is not enough: a normal exit of Js does not
// end a linked process, so the relay also monitors Js.
const RELAY_SOURCE = `
Self = self(),
Mon = erlang:monitor(process, Js),
Args = [case X of '$self' -> Self; _ -> X end || X <- A],
case catch erlang:apply(M, F, Args) of
  {'EXIT', Reason} ->
    Js ! {'$erlnode_relay', Ref, {error, Reason}};
  Result ->
    Js ! {'$erlnode_relay', Ref, {ok, Result}},
    Loop = fun L() ->
      receive
        {'DOWN', Mon, process, _, _} -> ok;
        Msg -> Js ! Msg, L()
      end
    end,
    Loop()
end.`;

// Parsed RELAY_SOURCE per remote node. The node parses it itself, so the
// abstract format always matches its OTP release.
const relayCache = new WeakMap<ErlNode, Map<string, Promise<Term>>>();

function relayExprs(node: ErlNode, remote: string): Promise<Term> {
  let perNode = relayCache.get(node);
  if (!perNode) relayCache.set(node, (perNode = new Map()));
  let exprs = perNode.get(remote);
  if (!exprs) {
    exprs = (async () => {
      const chars = Array.from(RELAY_SOURCE, (c) => c.charCodeAt(0));
      const scanned = (await node.rpc(remote, "erl_scan", "string", [chars])) as Tuple;
      if (scanned.at(0) !== atom("ok")) throw new Error(`erl_scan failed: ${format(scanned)}`);
      const parsed = (await node.rpc(remote, "erl_parse", "parse_exprs", [scanned.at(1)!])) as Tuple;
      if (parsed.at(0) !== atom("ok")) throw new Error(`erl_parse failed: ${format(parsed)}`);
      return parsed.at(1)!;
    })();
    exprs.catch(() => perNode!.delete(remote));
    perNode.set(remote, exprs);
  }
  return exprs;
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
