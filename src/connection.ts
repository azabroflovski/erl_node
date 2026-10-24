import type { Socket } from "node:net";
import { decodeFrom, encode, Reader, type Term, Tuple } from "./etf.ts";
import { frame, type FrameReader } from "./framing.ts";

const PASS_THROUGH = 112;
const TICK = Buffer.alloc(4);
// Remote nodes send a tick every net_ticktime / 4 (15 s by default) and drop
// the connection after net_ticktime of silence. We tick on the same schedule
// whenever we have not written anything else.
const TICK_INTERVAL = 15_000;

export type MessageHandler = (control: Tuple, payload: Term | undefined) => void;

/** A distribution connection after the handshake: 4-byte frames, ticks, pass-through messages. */
export class Connection {
  private wrote = false;
  private ticker: ReturnType<typeof setInterval>;
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
        if (f[0] !== PASS_THROUGH) throw new Error(`unsupported distribution header ${f[0]}`);
        const r = new Reader(f, 1);
        const control = decodeFrom(r);
        if (!(control instanceof Tuple)) throw new Error("control message is not a tuple");
        const payload = r.pos < f.length ? decodeFrom(r) : undefined;
        this.onMessage(control, payload);
      }
    } catch (err) {
      this.shutdown(err as Error);
    }
  }

  /** Sends a control message and an optional payload. */
  send(control: Tuple, payload?: Term) {
    if (this.closed) throw new Error(`connection to ${this.peerName} is closed`);
    const parts = [Uint8Array.of(PASS_THROUGH), encode(control)];
    if (payload !== undefined) parts.push(encode(payload));
    this.socket.write(frame(4, Buffer.concat(parts)));
    this.wrote = true;
  }

  close() {
    this.shutdown(new Error("connection closed by us"));
  }

  private shutdown(err: Error) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.socket.destroy();
    this.resolveDone(err);
  }
}
