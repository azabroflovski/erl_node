import { randomInt } from "node:crypto";
import { createServer, type Server, connect as tcpConnect, type Socket } from "node:net";
import { Connection, OP } from "./connection.ts";
import { portPlease, register, type Registration } from "./epmd.ts";
import { Atom, atom, copy, format, Pid, Ref, type Term, Tuple, tuple } from "./etf.ts";
import { FrameReader } from "./framing.ts";
import { acceptHandshake, DFLAG, handshake, HandshakeError } from "./handshake.ts";
import { debug, debugEnabled } from "./debug.ts";
import { erlangName } from "./names.ts";
import { isDown, Process, SpawnError, TimeoutError } from "./process.ts";

/**
 * Where a message goes, as in Elixir's `send/2`: a pid, a name registered on
 * this node, or `[name, node]` for a name registered on another node.
 */
export type Dest = Pid | string | [name: string, node: string];

/** What `node.module<T>` returns: functions named by `T`, or `T` itself when it is an interface. */
export type RemoteModule<T> = [T] extends [string] ? { [F in T & string]: (...args: Term[]) => Promise<Term> } : T;

export interface NodeOptions {
  /** Our node name, e.g. `js@localhost`. */
  name: string;
  cookie: string;
}

/**
 * An `erpc` call raised. `kind` is the Erlang exception class: `throw`,
 * `exit` or `error`; `remoteStack` is the Erlang stacktrace for errors.
 */
export class ErpcError extends Error {
  constructor(
    readonly kind: "throw" | "exit" | "error",
    readonly reason: Term,
    readonly remoteStack?: Term,
  ) {
    super(`erpc ${kind}: ${format(reason)}`);
  }
}

/** A `call` failed because the target process is gone or exited before replying. */
export class CallError extends Error {
  constructor(
    message: string,
    readonly reason: Term,
  ) {
    super(message);
  }
}

/**
 * A hidden Erlang node implemented in JS. It connects to other nodes on
 * demand and, after `listen()`, accepts connections from them.
 */
export class ErlNode {
  readonly name: Atom;
  readonly creation = randomInt(4, 2 ** 32);
  /** Sender pid for messages sent from outside a process. */
  readonly pid: Pid;

  private cookie: string;
  private connections = new Map<string, Promise<Connection>>();
  private established = new Map<string, Connection>();
  private processes = new Map<number, Process>();
  private names = new Map<string, Process>();
  private arrivals = new Map<string, Array<(conn: Connection) => void>>();
  private nextPidId = 1;
  private nextRefId = 1;
  private groupLeader?: Process;
  private server?: Server;
  private registration?: Registration;
  private closing = false;
  private restarts = new Set<ReturnType<typeof setTimeout>>();

  constructor(opts: NodeOptions) {
    if (!opts.name.includes("@")) throw new Error(`node name must look like name@host, got ${opts.name}`);
    this.name = atom(opts.name);
    this.cookie = opts.cookie;
    this.pid = this.makePid();
  }

  /**
   * Connects to `remote` (`name@host`), like `Node.connect/1`. Optional:
   * `send`, `call` and the rest connect on first use. Connecting to a node
   * we are already connected to does nothing.
   */
  async connect(remote: string): Promise<void> {
    await this.dial(remote);
  }

  /** Closes the connection to `remote`, like `Node.disconnect/1`. */
  disconnect(remote: string) {
    this.established.get(remote)?.close();
  }

  /** Nodes we are connected to, like `Node.list(:connected)`. */
  list(): string[] {
    return [...this.established.keys()];
  }

  /** The established connection to `remote`, if there is one. */
  connection(remote: string): Connection | undefined {
    return this.established.get(remote);
  }

  private dial(remote: string): Promise<Connection> {
    let conn = this.connections.get(remote);
    if (!conn) {
      conn = this.openConnection(remote);
      this.connections.set(remote, conn);
      conn.catch((err: Error) => {
        this.connections.delete(remote);
        if (debugEnabled()) debug(`connecting to ${remote} failed: ${err.message}`);
      });
    }
    return conn;
  }

  private async openConnection(remote: string): Promise<Connection> {
    const [alive, host] = remote.split("@");
    if (!alive || !host) throw new Error(`node name must look like name@host, got ${remote}`);
    const { port } = await portPlease(host, alive);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = tcpConnect(port, host, () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });
    socket.setNoDelay(true);
    const reader = new FrameReader(socket);
    try {
      const hs = await handshake(socket, reader, {
        name: this.name.name,
        cookie: this.cookie,
        creation: this.creation,
      });
      const conn = new Connection(hs.peerName, hs.peerFlags, socket, reader);
      this.adopt(remote, conn);
      return conn;
    } catch (err) {
      socket.destroy();
      // Both sides connected at once and the remote's attempt won:
      // its incoming connection becomes ours.
      if (err instanceof HandshakeError && err.status === "nok") return this.waitForIncoming(remote, 5000);
      throw err;
    }
  }

  private waitForIncoming(remote: string, timeout: number): Promise<Connection> {
    const now = this.established.get(remote);
    if (now) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.arrivals.set(remote, (this.arrivals.get(remote) ?? []).filter((f) => f !== done));
        reject(new HandshakeError(`connection to ${remote} lost a simultaneous connect`));
      }, timeout);
      const done = (conn: Connection) => {
        clearTimeout(timer);
        resolve(conn);
      };
      this.arrivals.set(remote, [...(this.arrivals.get(remote) ?? []), done]);
    });
  }

  private adopt(remote: string, conn: Connection) {
    this.established.set(remote, conn);
    conn.onMessage = (control, payload) => this.dispatch(conn, control, payload);
    void conn.done.then(() => {
      if (this.established.get(remote) === conn) {
        this.established.delete(remote);
        this.connections.delete(remote);
      }
      for (const p of [...this.processes.values()]) p.connectionLost(remote);
    });
    for (const f of this.arrivals.get(remote) ?? []) f(conn);
    this.arrivals.delete(remote);
  }


  /**
   * Accepts connections from other nodes and registers this node in the
   * local EPMD, so that `send({name, :"js@host"}, msg)` works from Erlang.
   * Resolves with the port. Listens on all interfaces unless `host` is given.
   */
  async listen(opts: { host?: string; port?: number } = {}): Promise<number> {
    if (this.server) throw new Error("already listening");
    const server = createServer((socket) => void this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, opts.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const port = (server.address() as { port: number }).port;
    try {
      this.registration = await register(this.name.name.split("@")[0]!, port);
    } catch (err) {
      server.close();
      throw err;
    }
    this.server = server;
    return port;
  }

  private async accept(socket: Socket) {
    socket.setNoDelay(true);
    const reader = new FrameReader(socket);
    try {
      const hs = await acceptHandshake(socket, reader, {
        name: this.name.name,
        cookie: this.cookie,
        creation: this.creation,
        decide: (peer) => {
          if (this.established.has(peer)) return "alive";
          // Simultaneous connect: the node with the greater name wins.
          if (this.connections.has(peer)) return peer > this.name.name ? "ok_simultaneous" : "nok";
          return "ok";
        },
        replace: (peer) => this.established.get(peer)?.close(),
      });
      const conn = new Connection(hs.peerName, hs.peerFlags, socket, reader);
      if (!this.connections.has(hs.peerName)) this.connections.set(hs.peerName, Promise.resolve(conn));
      this.adopt(hs.peerName, conn);
    } catch (err) {
      if (debugEnabled()) debug(`incoming connection refused: ${(err as Error).message}`);
      socket.destroy();
    }
  }

  private local(pid: Term | undefined): Process | undefined {
    if (!(pid instanceof Pid) || pid.node !== this.name || pid.creation !== this.creation) return undefined;
    return this.processes.get(pid.id);
  }

  private localOrNamed(proc: Term | undefined): Process | undefined {
    return proc instanceof Atom ? this.names.get(proc.name) : this.local(proc);
  }

  private dispatch(conn: Connection, c: Tuple, payload: Term | undefined) {
    const [op, a, b, d] = c.elements;
    switch (op) {
      case OP.SEND:
      case OP.SEND_SENDER:
        if (payload !== undefined) this.local(b)?.deliver(payload);
        return;
      case OP.REG_SEND:
        if (payload !== undefined && d instanceof Atom) this.names.get(d.name)?.deliver(payload);
        return;
      case OP.LINK: {
        if (!(a instanceof Pid)) return;
        const mb = this.local(b);
        if (mb) mb.links.set(a.key, { pid: a });
        else conn.exit(b as Pid, a, atom("noproc"));
        return;
      }
      case OP.EXIT:
      case OP.PAYLOAD_EXIT:
        if (a instanceof Pid) this.local(b)?.linkExit(a, op === OP.EXIT ? d! : payload!);
        return;
      case OP.EXIT2:
      case OP.PAYLOAD_EXIT2:
        if (a instanceof Pid) this.local(b)?.exitSignal(a, op === OP.EXIT2 ? d! : payload!, true);
        return;
      case OP.MONITOR_P: {
        if (!(a instanceof Pid) || !(d instanceof Ref)) return;
        const mb = this.localOrNamed(b);
        if (mb) mb.monitoredBy.set(d.key, { ref: d, pid: a, proc: b as Pid | Atom });
        else conn.monitorExit(b as Pid | Atom, a, d, atom("noproc"));
        return;
      }
      case OP.DEMONITOR_P:
        if (d instanceof Ref) this.localOrNamed(b)?.monitoredBy.delete(d.key);
        return;
      case OP.MONITOR_P_EXIT:
      case OP.PAYLOAD_MONITOR_P_EXIT:
        if (d instanceof Ref) this.local(b)?.monitorDown(d, op === OP.MONITOR_P_EXIT ? c.at(4)! : payload!);
        return;
      case OP.UNLINK_ID: {
        // {35, Id, From, To}: the remote removed its link to us.
        const mb = this.local(d);
        if (!(b instanceof Pid) || !mb) return;
        if (mb.links.get(b.key)?.unlinking === undefined) mb.links.delete(b.key);
        conn.trySend(tuple(OP.UNLINK_ID_ACK, a!, d!, b));
        return;
      }
      case OP.SPAWN_REQUEST:
        // {29, ReqId, From, GroupLeader, MFA, Opts}: we cannot run Erlang code.
        if (a instanceof Ref && b instanceof Pid) conn.trySend(tuple(OP.SPAWN_REPLY, a, b, 0, atom("notsup")));
        return;
      case OP.SPAWN_REPLY: {
        // {31, ReqId, To, Flags, Result}
        const [, reqId, to, flags, result] = c.elements;
        if (reqId instanceof Ref && typeof flags === "number") this.local(to)?.spawnReply(reqId, flags, result!);
        return;
      }
      case OP.UNLINK_ID_ACK: {
        // {36, Id, From, To}: the remote confirmed our UNLINK_ID.
        const mb = this.local(d);
        if (!(b instanceof Pid) || !mb) return;
        if (mb.links.get(b.key)?.unlinking === a) mb.links.delete(b.key);
        return;
      }
      default:
        return; // not supported yet
    }
  }

  makePid(): Pid {
    const id = this.nextPidId++;
    return new Pid(this.name, id & 0x7fff_ffff, 0, this.creation);
  }

  makeRef(): Ref {
    const n = this.nextRefId++;
    // Erlang's first reference word holds 18 bits.
    return new Ref(this.name, this.creation, [n & 0x3ffff, randomInt(0, 2 ** 32), Math.floor(n / 0x40000)]);
  }

  /**
   * Starts a process running `fn`, like `spawn/1`, and returns its pid.
   * The process exits with `:normal` when `fn` returns, and with
   * `{:js_error, message}` when it throws; the error is also logged, as
   * Erlang logs crashed processes.
   *
   * With `restart`, a process that exits for any reason other than
   * `:normal`, `:shutdown` or `{:shutdown, _}` is started again after
   * `delay` ms (1000 by default), like a `:transient` child of a supervisor.
   * Each run gets a new pid; register a name to give it a stable address.
   * `node.close()` stops restarting.
   */
  spawn(fn: (self: Process) => unknown, opts: { restart?: boolean | { delay?: number } } = {}): Pid {
    const p = this.process();
    if (opts.restart && !this.closing) {
      const delay = (typeof opts.restart === "object" && opts.restart.delay) || 1000;
      p.onExit = (reason) => {
        if (this.closing || isShutdown(reason)) return;
        const timer = setTimeout(() => {
          this.restarts.delete(timer);
          if (!this.closing) this.spawn(fn, opts);
        }, delay);
        this.restarts.add(timer);
      };
    }
    void (async () => {
      try {
        await fn(p);
        p.exit();
      } catch (err) {
        // A process killed by a signal sees its pending receive fail; that is not a crash.
        if (!p.alive) return;
        console.error(`erlnode: process ${p.pid} crashed:`, err);
        p.exit(jsErrorReason(err));
      }
    })();
    return p.pid;
  }

  /**
   * Starts a process registered as `name` that answers like a GenServer:
   *
   * - `GenServer.call({name, node}, req)` runs `call(req, from)`; what it
   *   returns is the reply (`undefined` replies `:ok`);
   * - `GenServer.cast({name, node}, req)` runs `cast(req)`;
   * - any other message runs `info(msg)`.
   *
   * Messages are handled one at a time, in order. Keep state in variables
   * around the handlers. A handler that throws crashes the process, so a
   * pending call fails on the caller's side; pass `restart` to start it
   * again, as with `spawn`. Returns the pid of the first run.
   */
  serve(
    name: string,
    handlers: {
      call?: (request: Term, from: Term) => Term | void | Promise<Term | void>;
      cast?: (request: Term) => unknown;
      info?: (msg: Term) => unknown;
    },
    opts: { restart?: boolean | { delay?: number } } = {},
  ): Pid {
    return this.spawn(async (self) => {
      self.register(name);
      for await (const msg of self) {
        const [tag, a, b] = msg instanceof Tuple ? msg.elements : [];
        if (tag === atom("$gen_call") && msg instanceof Tuple && msg.length === 3) {
          if (!handlers.call) throw new Error(`${name} got a call but has no call handler`);
          const reply = await handlers.call(b!, a!);
          await this.reply(a!, reply === undefined ? atom("ok") : reply);
        } else if (tag === atom("$gen_cast") && msg instanceof Tuple && msg.length === 2) {
          await handlers.cast?.(a!);
        } else {
          await handlers.info?.(msg);
        }
      }
    }, opts);
  }

  /**
   * Calls `handler` for every broadcast on Phoenix.PubSub `topic` of `remote`:
   * `node.subscribe(APP, "MyApp.PubSub", "orders", (event) => ...)`.
   * When the subscription or the connection is lost, it subscribes again
   * after `retry` ms (1000 by default). Errors thrown by `handler` are logged
   * and do not end the subscription. Returns a function that unsubscribes.
   *
   * It is a process running the usual loop: `self.subscribe`, `for await`,
   * `trapExit` to notice when the relay goes away.
   */
  subscribe(
    remote: string,
    pubsub: string,
    topic: string,
    handler: (event: Term) => unknown,
    opts: { retry?: number } = {},
  ): () => Promise<void> {
    const retry = opts.retry ?? 1000;
    const pid = this.spawn(async (self) => {
      self.trapExit = true;
      let failing = false;
      while (self.alive) {
        try {
          await self.subscribe(remote, pubsub, topic);
          failing = false;
          for await (const msg of self) {
            if (msg instanceof Tuple && msg.at(0) === atom("EXIT")) break; // relay or connection gone
            try {
              await handler(msg);
            } catch (err) {
              console.error(`erlnode: handler for ${topic} on ${remote} failed:`, err);
            }
          }
        } catch (err) {
          if (!self.alive) return;
          if (!failing) console.error(`erlnode: cannot subscribe to ${topic} on ${remote}, retrying:`, err);
          failing = true;
        }
        // Wait before the next attempt; a stopped process ends the wait at once.
        await self.receive(() => false, retry).catch(() => {});
      }
    });
    return () => this.exit(pid, atom("kill"));
  }

  /**
   * Sends an exit signal to `pid`, like `Process.exit/2`. `:kill` ends the
   * process unconditionally; other reasons follow the target's `trapExit`.
   */
  async exit(pid: Pid, reason: Term): Promise<void> {
    if (pid.node === this.name) return this.local(pid)?.exitSignal(this.pid, copy(reason), true);
    const conn = await this.dial(pid.node.name);
    if (conn.peerFlags & DFLAG.EXIT_PAYLOAD) conn.send(tuple(OP.PAYLOAD_EXIT2, this.pid, pid), reason);
    else conn.send(tuple(OP.EXIT2, this.pid, pid, reason));
  }

  // A process without a body, for request/reply helpers like `call`.
  private process(): Process {
    const p = new Process(this.makePid(), this);
    this.processes.set(p.pid.id, p);
    return p;
  }

  /** Forgets an exited process and its names. Called by `Process.exit`. */
  drop(p: Process) {
    this.processes.delete(p.pid.id);
    for (const [name, owner] of this.names) if (owner === p) this.names.delete(name);
  }

  /** Registers `p` under `name`, so remote processes can send to `{name, node}`. */
  register(name: string, p: Process) {
    if (!p.alive) throw new Error("process exited");
    name = erlangName(name);
    const owner = this.names.get(name);
    if (owner && owner !== p) throw new Error(`name ${name} is already registered`);
    this.names.set(name, p);
  }

  /** The live process on this node with this pid or registered name. */
  lookup(target: Pid | string): Process | undefined {
    return typeof target === "string" ? this.names.get(erlangName(target)) : this.local(target);
  }

  /** The pid registered under `name`, like `Process.whereis/1`. */
  whereis(name: string): Pid | undefined {
    return this.names.get(erlangName(name))?.pid;
  }

  /**
   * Answers a `GenServer.call` that arrived as `{:"$gen_call", from, request}`,
   * like `GenServer.reply(from, value)`.
   */
  reply(from: Term, value: Term): Promise<void> {
    if (!(from instanceof Tuple) || !(from.at(0) instanceof Pid)) throw new TypeError("from must be {pid, tag}");
    return this.send(from.at(0) as Pid, tuple(from.at(1)!, value));
  }

  /**
   * Sends `msg` to `to`, like Elixir's `send/2`. `from` is the sender pid the
   * remote side sees. Resolves once the message is written to the socket.
   * Sending to an unregistered local name throws, as in Erlang; messages to
   * a missing name on another node are dropped.
   */
  async send(to: Dest, msg: Term, from: Pid = this.pid): Promise<void> {
    if (typeof to === "string") {
      const mb = this.names.get(erlangName(to));
      if (!mb) throw new Error(`no process registered as ${to}`);
      return mb.deliver(copy(msg));
    }
    if (to instanceof Pid) {
      if (to.node === this.name) return this.local(to)?.deliver(copy(msg));
      const conn = await this.dial(to.node.name);
      if (conn.peerFlags & DFLAG.SEND_SENDER) conn.send(tuple(OP.SEND_SENDER, from, to), msg);
      else conn.send(tuple(OP.SEND, atom(""), to), msg);
      return;
    }
    const [name, node] = [erlangName(to[0]), to[1]];
    if (node === this.name.name) return this.names.get(name)?.deliver(copy(msg));
    const conn = await this.dial(node);
    conn.send(tuple(OP.REG_SEND, from, atom(""), atom(name)), msg);
  }

  /**
   * `GenServer.call(to, request, timeout)`. `to` is a pid or `[name, node]`
   * (`["Counter", node]` is the Elixir `Counter`, see `erlangName`).
   * Fails with `CallError` if the process does not exist, exits before
   * replying or its node disconnects, and with `TimeoutError` on timeout.
   */
  async call(to: Pid | [name: string, node: string], request: Term, timeout = 5000): Promise<Term> {
    const mb = this.process();
    try {
      // Like gen:call, the monitor reference doubles as the reply tag.
      const ref = await mb.monitor(to);
      await mb.send(to, tuple(atom("$gen_call"), tuple(mb.pid, ref), request));
      const msg = (await mb.receive(
        (m) => isDown(m, ref) || (m instanceof Tuple && m.length === 2 && ref.equals(m.at(0))),
        timeout,
      )) as Tuple;
      if (msg.length === 2) return msg.at(1)!;
      const reason = msg.at(4)!;
      const target = to instanceof Pid ? String(to) : `${to[0]} on ${to[1]}`;
      throw new CallError(`call to ${target} failed: ${format(reason)}`, reason);
    } finally {
      mb.exit();
    }
  }

  /**
   * `:rpc.call(node, m, f, args, timeout)`. Output the function writes to its
   * group leader is discarded.
   */
  rpc(node: string, m: string, f: string, args: Term[] = [], timeout = 5000): Promise<Term> {
    const gl = this.groupLeaderPid();
    return this.call(["rex", node], tuple(atom("call"), atom(erlangName(m)), atom(f), args, gl), timeout);
  }

  /**
   * The group leader given to processes started through this node. It keeps
   * remote code doing IO from blocking: output requests are acknowledged and
   * dropped, input requests fail.
   */
  groupLeaderPid(): Pid {
    if (this.groupLeader) return this.groupLeader.pid;
    const gl = this.process();
    this.groupLeader = gl;
    const loop = async () => {
      for (;;) {
        let msg: Term;
        try {
          msg = await gl.receive();
        } catch {
          return;
        }
        if (!(msg instanceof Tuple) || msg.at(0) !== atom("io_request") || msg.length !== 4) continue;
        const [, from, replyAs, req] = msg.elements;
        if (!(from instanceof Pid)) continue;
        const reply = isOutputRequest(req!) ? atom("ok") : tuple(atom("error"), atom("enotsup"));
        void this.send(from, tuple(atom("io_reply"), replyAs!, reply), gl.pid).catch(() => {});
      }
    };
    void loop();
    return gl.pid;
  }

  /**
   * `:erpc.call(node, m, f, args, timeout)`: runs the function in a new process
   * on `node`. Exceptions come back as `ErpcError` with the Erlang class and
   * reason. On timeout the remote process keeps running, as with `:erpc`.
   */
  async erpc(node: string, m: string, f: string, args: Term[] = [], timeout = 5000): Promise<Term> {
    const mb = this.process();
    try {
      const res = this.makeRef();
      const deadline = Date.now() + timeout;
      const spawned = await withTimeout(
        mb.spawnOn(node, "erpc", "execute_call", [res, atom(erlangName(m)), atom(f), args], { monitor: true }),
        timeout,
      ).catch((err) => {
        throw err instanceof SpawnError ? new ErpcError("error", tuple(atom("erpc"), err.reason)) : err;
      });
      const left = Math.max(0, deadline - Date.now());
      const down = (await mb.receive((msg) => isDown(msg, spawned.ref!), left)) as Tuple;
      const reason = down.at(4)!;
      // erpc:execute_call exits with {Res, Class, Reason} or {Res, error, Reason, Stack}.
      if (reason instanceof Tuple && res.equals(reason.at(0))) {
        const [, cls, value, stack] = reason.elements;
        if (cls === atom("return")) return value!;
        throw new ErpcError((cls as Atom).name as ErpcError["kind"], value!, stack);
      }
      if (reason === atom("noconnection")) throw new ErpcError("error", tuple(atom("erpc"), reason));
      throw new ErpcError("exit", tuple(atom("signal"), reason));
    } finally {
      mb.exit();
    }
  }

  /**
   * The functions of module `mod` on `remote` as JS functions, each one an
   * `erpc` call:
   *
   *     const users = node.module(APP, "MyApp.Users");
   *     await users.get(1); // :erpc.call(APP, MyApp.Users, :get, [1])
   *
   * Names with `?` or `!` need brackets: `users["valid?"](x)`. Nothing is
   * checked up front: a missing function fails when called, with `ErpcError`.
   *
   * The type parameter is optional and only gives types, nothing is checked
   * at run time. It is either a union of function names,
   * `node.module<"get" | "list">(...)`, or an interface whose methods return
   * promises, `node.module<Users>(...)` with
   * `interface Users { get(id: number): Promise<Term> }`.
   */
  module<T extends string | object = string>(
    remote: string,
    mod: string,
    opts: { timeout?: number } = {},
  ): RemoteModule<T> {
    return new Proxy(
      {},
      {
        get: (_, fn) => {
          // `then` must stay undefined, or `await node.module(...)` would treat the proxy as a promise.
          if (typeof fn !== "string" || fn === "then") return undefined;
          return (...args: Term[]) => this.erpc(remote, mod, fn, args, opts.timeout);
        },
      },
    ) as RemoteModule<T>;
  }

  /** Ends all processes with `:shutdown`, stops listening, unregisters from EPMD and closes all connections. */
  async close() {
    this.closing = true;
    for (const timer of this.restarts) clearTimeout(timer);
    this.restarts.clear();
    for (const p of [...this.processes.values()]) p.exit(atom("shutdown"));
    this.groupLeader = undefined;
    this.registration?.close();
    this.registration = undefined;
    this.server?.close();
    this.server = undefined;
    const conns = await Promise.allSettled(this.connections.values());
    for (const c of conns) if (c.status === "fulfilled") c.value.close();
  }
}

/** The exit reason of a process whose JS code threw `err`: `{:js_error, message}`. */
export function jsErrorReason(err: unknown): Term {
  return tuple(atom("js_error"), err instanceof Error ? err.message : String(err));
}

/** `:normal`, `:shutdown` and `{:shutdown, _}`: exits a supervisor does not restart. */
function isShutdown(reason: Term): boolean {
  if (reason === atom("normal") || reason === atom("shutdown")) return true;
  return reason instanceof Tuple && reason.length === 2 && reason.at(0) === atom("shutdown");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms)) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`no reply within ${ms} ms`)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

function isOutputRequest(req: Term): boolean {
  if (!(req instanceof Tuple)) return false;
  const op = req.at(0);
  if (op === atom("put_chars")) return true;
  if (op === atom("requests")) {
    const list = req.at(1);
    return Array.isArray(list) && list.every(isOutputRequest);
  }
  return false;
}

/**
 * Starts a node named `name` (`name@host`), like `Node.start/1`. It makes no
 * connections until it needs them; call `listen()` to accept them as well.
 */
export function start(opts: NodeOptions): ErlNode {
  return new ErlNode(opts);
}
