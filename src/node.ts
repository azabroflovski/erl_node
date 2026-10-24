import { randomInt } from "node:crypto";
import { createServer, type Server, connect as tcpConnect, type Socket } from "node:net";
import { Connection, OP } from "./connection.ts";
import { portPlease, register, type Registration } from "./epmd.ts";
import { Atom, atom, format, Pid, Ref, type Term, Tuple, tuple } from "./etf.ts";
import { FrameReader } from "./framing.ts";
import { acceptHandshake, DFLAG, handshake, HandshakeError } from "./handshake.ts";
import { isDown, Mailbox } from "./mailbox.ts";

export interface NodeOptions {
  /** Our node name, e.g. `js@localhost`. */
  name: string;
  cookie: string;
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

const EXIT = atom("EXIT");

/**
 * A hidden Erlang node implemented in JS. It connects to other nodes on
 * demand and, after `listen()`, accepts connections from them.
 */
export class ErlNode {
  readonly name: Atom;
  readonly creation = randomInt(4, 2 ** 32);
  /** Default remote node for registered names. */
  remote?: string;
  /** Sender pid for messages sent without an explicit mailbox. */
  readonly pid: Pid;

  private cookie: string;
  private connections = new Map<string, Promise<Connection>>();
  private established = new Map<string, Connection>();
  private mailboxes = new Map<number, Mailbox>();
  private names = new Map<string, Mailbox>();
  private arrivals = new Map<string, Array<(conn: Connection) => void>>();
  private nextPidId = 1;
  private nextRefId = 1;
  private groupLeader?: Mailbox;
  private server?: Server;
  private registration?: Registration;

  constructor(opts: NodeOptions) {
    if (!opts.name.includes("@")) throw new Error(`node name must look like name@host, got ${opts.name}`);
    this.name = atom(opts.name);
    this.cookie = opts.cookie;
    this.pid = this.makePid();
  }

  /** Connects to `remote` (`name@host`), reusing an existing connection. */
  connect(remote: string): Promise<Connection> {
    let conn = this.connections.get(remote);
    if (!conn) {
      conn = this.openConnection(remote);
      this.connections.set(remote, conn);
      conn.catch(() => this.connections.delete(remote));
    }
    return conn;
  }

  /** The established connection to `remote`, if there is one. */
  connection(remote: string): Connection | undefined {
    return this.established.get(remote);
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
      for (const mb of [...this.mailboxes.values()]) mb.connectionLost(remote);
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
    } catch {
      socket.destroy();
    }
  }

  private local(pid: Term | undefined): Mailbox | undefined {
    if (!(pid instanceof Pid) || pid.node !== this.name || pid.creation !== this.creation) return undefined;
    return this.mailboxes.get(pid.id);
  }

  private localOrNamed(proc: Term | undefined): Mailbox | undefined {
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
        if (a instanceof Pid) this.local(b)?.deliver(tuple(EXIT, a, op === OP.EXIT2 ? d! : payload!));
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

  spawnMailbox(): Mailbox {
    const mb = new Mailbox(this.makePid(), this);
    this.mailboxes.set(mb.pid.id, mb);
    return mb;
  }

  /** Forgets a closed mailbox and its names. Called by `Mailbox.close`. */
  drop(mb: Mailbox) {
    this.mailboxes.delete(mb.pid.id);
    for (const [name, owner] of this.names) if (owner === mb) this.names.delete(name);
  }

  /** Registers `mb` under `name`, so remote processes can send to `{name, node}`. */
  register(name: string, mb: Mailbox) {
    if (mb.closed) throw new Error("mailbox closed");
    const owner = this.names.get(name);
    if (owner && owner !== mb) throw new Error(`name ${name} is already registered`);
    this.names.set(name, mb);
  }

  /** The mailbox registered under `name`. */
  whereis(name: string): Mailbox | undefined {
    return this.names.get(name);
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
   * Sends `msg` to a pid, or to a process registered under `to` on
   * `opts.node` (default: the node passed to `connect`).
   * Resolves once the message is written to the socket.
   */
  async send(to: Pid | string, msg: Term, opts: { node?: string; from?: Pid } = {}): Promise<void> {
    const from = opts.from ?? this.pid;
    if (to instanceof Pid) {
      const conn = await this.connect(to.node.name);
      if (conn.peerFlags & DFLAG.SEND_SENDER) conn.send(tuple(OP.SEND_SENDER, from, to), msg);
      else conn.send(tuple(OP.SEND, atom(""), to), msg);
      return;
    }
    const node = opts.node ?? this.remote;
    if (!node) throw new Error("no node given for a registered name");
    const conn = await this.connect(node);
    conn.send(tuple(OP.REG_SEND, from, atom(""), atom(to)), msg);
  }

  /**
   * `GenServer.call(to, request, timeout)` against a process on `node`.
   * `to` is a registered name (Elixir modules need the `Elixir.` prefix) or a pid.
   * Fails with `CallError` if the process does not exist, exits before
   * replying or its node disconnects, and with `TimeoutError` on timeout.
   */
  async call(node: string, to: Pid | string, request: Term, timeout = 5000): Promise<Term> {
    const mb = this.spawnMailbox();
    try {
      // Like gen:call, the monitor reference doubles as the reply tag.
      const ref = await mb.monitor(to, node);
      await mb.send(to, tuple(atom("$gen_call"), tuple(mb.pid, ref), request), node);
      const msg = (await mb.receive(
        (m) => isDown(m, ref) || (m instanceof Tuple && m.length === 2 && ref.equals(m.at(0))),
        timeout,
      )) as Tuple;
      if (msg.length === 2) return msg.at(1)!;
      const reason = msg.at(4)!;
      const target = typeof to === "string" ? `${to} on ${node}` : String(to);
      throw new CallError(`call to ${target} failed: ${format(reason)}`, reason);
    } finally {
      mb.close();
    }
  }

  /**
   * `:rpc.call(node, m, f, args, timeout)`. Output the function writes to its
   * group leader is discarded.
   */
  rpc(node: string, m: string, f: string, args: Term[] = [], timeout = 5000): Promise<Term> {
    const gl = this.groupLeaderPid();
    return this.call(node, "rex", tuple(atom("call"), atom(m), atom(f), args, gl), timeout);
  }

  // A minimal group leader so that remote code doing IO does not block:
  // output requests are acknowledged and dropped, input requests fail.
  private groupLeaderPid(): Pid {
    if (this.groupLeader) return this.groupLeader.pid;
    const gl = this.spawnMailbox();
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
        void this.send(from, tuple(atom("io_reply"), replyAs!, reply), { from: gl.pid }).catch(() => {});
      }
    };
    void loop();
    return gl.pid;
  }

  /** Stops listening, unregisters from EPMD and closes all connections. */
  async close() {
    this.groupLeader?.close();
    this.groupLeader = undefined;
    this.registration?.close();
    this.registration = undefined;
    this.server?.close();
    this.server = undefined;
    const conns = await Promise.allSettled(this.connections.values());
    for (const c of conns) if (c.status === "fulfilled") c.value.close();
  }
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

/** Creates a node and connects it to `remote`. */
export async function connect(remote: string, opts: NodeOptions): Promise<ErlNode> {
  const node = new ErlNode(opts);
  node.remote = remote;
  await node.connect(remote);
  return node;
}
