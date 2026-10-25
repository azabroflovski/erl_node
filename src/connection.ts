import type { Socket } from "node:net";
import { type Atom, decodeFrom, decodeRaw, encode, encodeRaw, type Pid, Reader, type Ref, type Term, Tuple, tuple } from "./etf.ts";
import { frame, type FrameReader } from "./framing.ts";
import { brief, debug, debugEnabled } from "./debug.ts";
import { DFLAG } from "./handshake.ts";

// Control message operations, see erl_dist_protocol.
export const OP = {
  LINK: 1,
  SEND: 2,
  EXIT: 3,
  REG_SEND: 6,
  EXIT2: 8,
  MONITOR_P: 19,
  DEMONITOR_P: 20,
  MONITOR_P_EXIT: 21,
  SEND_SENDER: 22,
  PAYLOAD_EXIT: 24,
  PAYLOAD_EXIT2: 26,
  PAYLOAD_MONITOR_P_EXIT: 28,
  SPAWN_REQUEST: 29,
  SPAWN_REPLY: 31,
  UNLINK_ID: 35,
  UNLINK_ID_ACK: 36,
} as const;

const OP_NAMES = new Map<unknown, string>(Object.entries(OP).map(([name, code]) => [code, name]));

// `{2, ...} + msg` as `SEND {2, ...} msg`, for the debug log.
function describe(control: Tuple, payload: Term | undefined): string {
  const name = OP_NAMES.get(control.at(0)) ?? "op";
  return `${name} ${brief(control)}${payload === undefined ? "" : ` ${brief(payload)}`}`;
}

const PASS_THROUGH = 112;
const VERSION = 131;
const DIST_HEADER = 68;
const DIST_FRAG_HEADER = 69;
const DIST_FRAG_CONT = 70;
const TICK = Buffer.alloc(4);
// Remote nodes send a tick every net_ticktime / 4 (15 s by default) and drop
// the connection after net_ticktime of silence. We tick on the same schedule
// whenever we have not written anything else.
const TICK_INTERVAL = 15_000;

export type MessageHandler = (control: Tuple, payload: Term | undefined) => void;

/**
 * A distribution connection after the handshake: 4-byte frames, ticks, messages.
 *
 * Without DFLAG_FRAGMENTS messages travel as pass-through frames (`p`, then
 * versioned terms). With it BEAM only accepts and sends frames with a
 * distribution header (`131 68`, `131 69`, `131 70`), whose terms have no
 * version byte. We never enable the atom cache, so headers carry no atom
 * cache references. Large incoming messages arrive in fragments; we send
 * ours whole, since we write them to the socket in one go anyway.
 */
export class Connection {
  private wrote = false;
  private ticker: ReturnType<typeof setInterval>;
  private fragments = new Map<bigint, { next: bigint; parts: Buffer[] }>();
  /** The peer negotiated DFLAG_FRAGMENTS, so messages use distribution headers. */
  readonly fragmented: boolean;
  private debug = debugEnabled();
  closed = false;
  /** Resolves with the reason once the connection is gone. */
  readonly done: Promise<Error>;
  private resolveDone!: (err: Error) => void;
  onMessage: MessageHandler = () => {};

  constructor(
    readonly peerName: string,
    readonly peerFlags: bigint,
    private socket: Socket,
    private reader: FrameReader,
  ) {
    this.fragmented = (peerFlags & DFLAG.FRAGMENTS) !== 0n;
    if (this.debug) debug(`connected to ${peerName}`);
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
    this.ticker = setInterval(() => {
      if (!this.wrote) this.socket.write(TICK);
      this.wrote = false;
    }, TICK_INTERVAL);
    this.ticker.unref?.();
    void this.loop();
  }

  private async loop() {
    try {
      for (;;) {
        const f = await this.reader.read(4);
        if (f.length === 0) {
          this.socket.write(TICK);
          this.wrote = true;
          continue;
        }
        this.receive(f);
      }
    } catch (err) {
      this.shutdown(err as Error);
    }
  }

  private receive(f: Buffer) {
    if (f[0] === PASS_THROUGH) {
      const r = new Reader(f, 1);
      const control = decodeFrom(r);
      const payload = r.pos < f.length ? decodeFrom(r) : undefined;
      return this.deliver(control, payload);
    }
    if (f[0] !== VERSION) throw new Error(`unsupported distribution header ${f[0]}`);
    switch (f[1]) {
      case DIST_HEADER:
        return this.decodeMessage(f.subarray(2));
      case DIST_FRAG_HEADER: {
        const seq = f.readBigUInt64BE(2);
        const frag = f.readBigUInt64BE(10);
        if (frag === 1n) return this.decodeMessage(f.subarray(18));
        this.fragments.set(seq, { next: frag - 1n, parts: [f.subarray(18)] });
        return;
      }
      case DIST_FRAG_CONT: {
        const seq = f.readBigUInt64BE(2);
        const frag = f.readBigUInt64BE(10);
        const pending = this.fragments.get(seq);
        if (!pending || pending.next !== frag) throw new Error(`unexpected fragment ${frag} of sequence ${seq}`);
        pending.parts.push(f.subarray(18));
        if (frag !== 1n) {
          pending.next = frag - 1n;
          return;
        }
        this.fragments.delete(seq);
        return this.decodeMessage(Buffer.concat(pending.parts));
      }
      default:
        throw new Error(`unsupported distribution header 131 ${f[1]}`);
    }
  }

  // Body after a distribution header: atom cache refs, control, payload.
  private decodeMessage(body: Buffer) {
    if (body[0] !== 0) throw new Error("atom cache references are not supported");
    const r = new Reader(body, 1);
    const control = decodeRaw(r);
    const payload = r.pos < body.length ? decodeRaw(r) : undefined;
    this.deliver(control, payload);
  }

  private deliver(control: Term, payload: Term | undefined) {
    if (!(control instanceof Tuple)) throw new Error("control message is not a tuple");
    if (this.debug) debug(`${this.peerName} → ${describe(control, payload)}`);
    this.onMessage(control, payload);
  }

  /** Sends a control message and an optional payload. */
  send(control: Tuple, payload?: Term) {
    if (this.closed) throw new Error(`connection to ${this.peerName} is closed`);
    if (this.debug) debug(`→ ${this.peerName} ${describe(control, payload)}`);
    this.wrote = true;
    if (!this.fragmented) {
      const parts = [Uint8Array.of(PASS_THROUGH), encode(control)];
      if (payload !== undefined) parts.push(encode(payload));
      this.socket.write(frame(4, Buffer.concat(parts)));
      return;
    }
    // 131 68, then zero atom cache references.
    const parts = [Uint8Array.of(VERSION, DIST_HEADER, 0), encodeRaw(control)];
    if (payload !== undefined) parts.push(encodeRaw(payload));
    this.socket.write(frame(4, Buffer.concat(parts)));
  }

  /** Like `send`, but does nothing once the connection is closed. */
  trySend(control: Tuple, payload?: Term) {
    if (!this.closed) this.send(control, payload);
  }

  /** Exit signal over a link from `from` to `to`. */
  exit(from: Pid, to: Pid, reason: Term) {
    if (this.peerFlags & DFLAG.EXIT_PAYLOAD) this.trySend(tuple(OP.PAYLOAD_EXIT, from, to), reason);
    else this.trySend(tuple(OP.EXIT, from, to, reason));
  }

  /** Tells the monitoring process `to` that `from` is gone. */
  monitorExit(from: Pid | Atom, to: Pid, ref: Ref, reason: Term) {
    if (this.peerFlags & DFLAG.EXIT_PAYLOAD) this.trySend(tuple(OP.PAYLOAD_MONITOR_P_EXIT, from, to, ref), reason);
    else this.trySend(tuple(OP.MONITOR_P_EXIT, from, to, ref, reason));
  }

  close() {
    this.shutdown(new Error("connection closed by us"));
  }

  private shutdown(err: Error) {
    if (this.closed) return;
    this.closed = true;
    if (this.debug) debug(`connection to ${this.peerName} closed: ${err.message}`);
    clearInterval(this.ticker);
    this.socket.destroy();
    this.resolveDone(err);
  }
}
