import { randomInt } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";
import { Connection } from "./connection.ts";
import { portPlease } from "./epmd.ts";
import { Atom, atom, Pid, Ref, type Term, Tuple, tuple } from "./etf.ts";
import { FrameReader } from "./framing.ts";
import { DFLAG, handshake } from "./handshake.ts";

// Control message operations, see erl_dist_protocol.
const SEND = 2;
const REG_SEND = 6;
const SEND_SENDER = 22;

export interface NodeOptions {
  /** Our node name, e.g. `js@localhost`. */
  name: string;
  cookie: string;
}

export class TimeoutError extends Error {}

type Waiter = {
  match: (msg: Term) => boolean;
  resolve: (msg: Term) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** A process-like mailbox owned by the JS node, addressable by its pid. */
export class Mailbox {
  private queue: Term[] = [];
  private waiters: Waiter[] = [];

  constructor(
    readonly pid: Pid,
    private node: ErlNode,
  ) {}

  /** @internal */
  deliver(msg: Term) {
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

  /** Sends `msg` with this mailbox's pid as the sender. */
  send(to: Pid | string, msg: Term, node?: string): Promise<void> {
    return this.node.send(to, msg, { node, from: this.pid });
  }

  /** Unregisters the mailbox; pending `receive` calls are rejected. */
  close() {
    this.node.unregister(this);
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("mailbox closed"));
    }
  }
}

/** A hidden Erlang node implemented in JS. It only makes outgoing connections. */
export class ErlNode {
  readonly name: Atom;
  readonly creation = randomInt(4, 2 ** 32);
  /** Default remote node for `send` with a registered name. */
  remote?: string;
  /** Sender pid for messages sent without an explicit mailbox. */
  readonly pid: Pid;

  private cookie: string;
  private connections = new Map<string, Promise<Connection>>();
  private mailboxes = new Map<number, Mailbox>();
  private nextPidId = 1;
  private nextRefId = 1;
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
      conn.then(
        (c) => c.done.then(() => this.connections.delete(remote)),
        () => this.connections.delete(remote),
      );
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
      conn.onMessage = (control, payload) => this.dispatch(control, payload);
      return conn;
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  private dispatch(control: Tuple, payload: Term | undefined) {
    const op = control.at(0);
    let to: Term | undefined;
    if (op === SEND) to = control.at(2);
    else if (op === SEND_SENDER) to = control.at(2);
    else if (op === REG_SEND) return; // we have no registered names
    else return; // links, monitors and the rest are not supported yet
    if (!(to instanceof Pid) || to.node !== this.name || to.creation !== this.creation) return;
    if (payload !== undefined) this.mailboxes.get(to.id)?.deliver(payload);
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
   */
  async call(node: string, to: Pid | string, request: Term, timeout = 5000): Promise<Term> {
    const conn = await this.connect(node);
    const mb = this.spawnMailbox();
    const ref = this.makeRef();
    try {
      await this.send(to, tuple(atom("$gen_call"), tuple(mb.pid, ref), request), { node, from: mb.pid });
      const reply = mb.receive((m) => m instanceof Tuple && m.length === 2 && ref.equals(m.at(0)), timeout);
      const lost = conn.done.then((err) => Promise.reject(err));
      return ((await Promise.race([reply, lost])) as Tuple).at(1)!;
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
