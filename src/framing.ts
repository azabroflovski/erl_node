import type { Socket } from "node:net";

/**
 * Splits a TCP stream into length-prefixed frames. A frame may arrive in
 * pieces or together with the next one; both cases are buffered here.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private error: Error | null = null;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.wake();
    });
    socket.on("close", () => this.fail(new Error("connection closed")));
    socket.on("error", (err) => this.fail(err));
  }

  private fail(err: Error) {
    this.error ??= err;
    this.wake();
  }

  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** Resolves with the next frame whose length prefix is `headerSize` (2 or 4) bytes. */
  async read(headerSize: 2 | 4): Promise<Buffer> {
    for (;;) {
      if (this.buf.length >= headerSize) {
        const len = headerSize === 2 ? this.buf.readUInt16BE(0) : this.buf.readUInt32BE(0);
        if (this.buf.length >= headerSize + len) {
          const frame = this.buf.subarray(headerSize, headerSize + len);
          this.buf = this.buf.subarray(headerSize + len);
          return frame;
        }
      }
      if (this.error) throw this.error;
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }
}

export function frame(headerSize: 2 | 4, body: Uint8Array): Buffer {
  const out = Buffer.alloc(headerSize + body.length);
  if (headerSize === 2) out.writeUInt16BE(body.length, 0);
  else out.writeUInt32BE(body.length, 0);
  out.set(body, headerSize);
  return out;
}
