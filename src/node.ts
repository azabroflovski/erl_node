import { randomInt } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";
import { Connection } from "./connection.ts";
import { portPlease } from "./epmd.ts";
import { Atom, atom, format, Pid, Ref, type Term, Tuple, tuple } from "./etf.ts";
import { FrameReader } from "./framing.ts";
import { DFLAG, handshake } from "./handshake.ts";
import { isDown, Mailbox, pidKey, refKey } from "./mailbox.ts";

// Control message operations, see erl_dist_protocol.
const LINK = 1;
const SEND = 2;
const EXIT = 3;
const REG_SEND = 6;
const EXIT2 = 8;
const MONITOR_P = 19;
const DEMONITOR_P = 20;
const MONITOR_P_EXIT = 21;
const SEND_SENDER = 22;
const PAYLOAD_EXIT = 24;
const PAYLOAD_EXIT2 = 26;
const PAYLOAD_MONITOR_P_EXIT = 28;
const UNLINK_ID = 35;
const UNLINK_ID_ACK = 36;

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

/** A hidden Erlang node implemented in JS. It only makes outgoing connections. */
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
  private nextPidId = 1;
  private nextRefId = 1;
  private unlinkId = 1;
  private groupLeader?: Mailbox;

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

  /** @internal Like `connect`, but resolves with null instead of failing. */
  connectOrNull(remote: string): Promise<Connection | null> {
    return this.connect(remote).catch(() => null);
  }

  /** @internal An established connection, if there is one. */
  connectionNow(remote: string): Connection | undefined {
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
      throw err;
    }
  }

  private adopt(remote: string, conn: Connection) {
    this.established.set(remote, conn);
    conn.onMessage = (control, payload) => this.dispatch(conn, control, payload);
    void conn.done.then(() => {
      this.established.delete(remote);
      this.connections.delete(remote);
      for (const mb of [...this.mailboxes.values()]) mb.connectionLost(remote);
    });
  }

  private local(pid: Term | undefined): Mailbox | undefined {
    if (!(pid instanceof Pid) || pid.node !== this.name || pid.creation !== this.creation) return undefined;
    return this.mailboxes.get(pid.id);
  }

  private dispatch(conn: Connection, c: Tuple, payload: Term | undefined) {
    const [op, a, b, d] = c.elements;
    switch (op) {
      case SEND:
      case SEND_SENDER:
        if (payload !== undefined) this.local(b)?.deliver(payload);
        return;
      case REG_SEND:
        return; // we have no registered names
      case LINK: {
        if (!(a instanceof Pid)) return;
        const mb = this.local(b);
        if (mb) mb.links.set(pidKey(a), { pid: a });
        else this.sendExit(conn, b as Pid, a, atom("noproc"));
        return;
      }
      case EXIT:
      case PAYLOAD_EXIT:
        if (a instanceof Pid) this.local(b)?.linkExit(a, op === EXIT ? d! : payload!);
        return;
      case EXIT2:
      case PAYLOAD_EXIT2:
        if (a instanceof Pid) this.local(b)?.deliver(tuple(atom("EXIT"), a, op === EXIT2 ? d! : payload!));
        return;
      case MONITOR_P: {
        if (!(a instanceof Pid) || !(d instanceof Ref)) return;
        const mb = this.local(b);
        if (mb) mb.monitoredBy.set(refKey(d), { ref: d, pid: a });
        else this.sendMonitorExit(conn, b as Pid | Atom, a, d, atom("noproc"));
        return;
      }
      case DEMONITOR_P:
        if (d instanceof Ref) this.local(b)?.monitoredBy.delete(refKey(d));
        return;
      case MONITOR_P_EXIT:
      case PAYLOAD_MONITOR_P_EXIT:
        if (d instanceof Ref) this.local(b)?.monitorDown(d, op === MONITOR_P_EXIT ? c.at(4)! : payload!);
        return;
      case UNLINK_ID: {
        // {35, Id, From, To}: the remote removed its link to us.
        const mb = this.local(d);
        if (!(b instanceof Pid) || !mb) return;
        const link = mb.links.get(pidKey(b));
        if (link && link.unlinking === undefined) mb.links.delete(pidKey(b));
        this.sendControl(conn, tuple(UNLINK_ID_ACK, a!, d!, b));
        return;
      }
      case UNLINK_ID_ACK: {
        // {36, Id, From, To}: the remote confirmed our UNLINK_ID.
        const mb = this.local(d);
        if (!(b instanceof Pid) || !mb) return;
        const link = mb.links.get(pidKey(b));
        if (link && link.unlinking === a) mb.links.delete(pidKey(b));
        return;
      }
      default:
        return; // not supported yet
    }
  }

  /** @internal */
  sendControl(conn: Connection, control: Tuple, payload?: Term) {
    if (!conn.closed) conn.send(control, payload);
  }

  /** @internal Exit signal over a link. */
  sendExit(conn: Connection, from: Pid, to: Pid, reason: Term) {
    if (conn.peerFlags & DFLAG.EXIT_PAYLOAD) this.sendControl(conn, tuple(PAYLOAD_EXIT, from, to), reason);
    else this.sendControl(conn, tuple(EXIT, from, to, reason));
  }

  /** @internal Tells a remote monitor that the monitored process is gone. */
  sendMonitorExit(conn: Connection, from: Pid | Atom, to: Pid, ref: Ref, reason: Term) {
    if (conn.peerFlags & DFLAG.EXIT_PAYLOAD) {
      this.sendControl(conn, tuple(PAYLOAD_MONITOR_P_EXIT, from, to, ref), reason);
    } else {
      this.sendControl(conn, tuple(MONITOR_P_EXIT, from, to, ref, reason));
    }
  }

  /** @internal */
  nextUnlinkId(): number {
    return this.unlinkId++;
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

  /** @internal */
  unregister(mb: Mailbox) {
    this.mailboxes.delete(mb.pid.id);
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
      if (conn.peerFlags & DFLAG.SEND_SENDER) conn.send(tuple(SEND_SENDER, from, to), msg);
      else conn.send(tuple(SEND, atom(""), to), msg);
      return;
    }
    const node = opts.node ?? this.remote;
    if (!node) throw new Error("no node given for a registered name");
    const conn = await this.connect(node);
    conn.send(tuple(REG_SEND, from, atom(""), atom(to)), msg);
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

  /** Closes all connections. */
  async close() {
    this.groupLeader?.close();
    this.groupLeader = undefined;
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
