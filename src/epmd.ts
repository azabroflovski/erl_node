import { connect } from "node:net";

export const EPMD_PORT = 4369;

const PORT_PLEASE2_REQ = 122;
const PORT2_RESP = 119;

export interface NodeInfo {
  port: number;
  /** 77 for a normal node, 72 for a hidden one. */
  nodeType: number;
  protocol: number;
  highestVersion: number;
  lowestVersion: number;
  name: string;
}

/**
 * Asks EPMD on `host` which port node `name` (the part before `@`) listens on.
 * Throws if the node is not registered.
 */
export async function portPlease(host: string, name: string, epmdPort = EPMD_PORT): Promise<NodeInfo> {
  const nameBytes = new TextEncoder().encode(name);
  const req = new Uint8Array(3 + nameBytes.length);
  const view = new DataView(req.buffer);
  view.setUint16(0, 1 + nameBytes.length);
  req[2] = PORT_PLEASE2_REQ;
  req.set(nameBytes, 3);

  // EPMD sends the reply and closes the connection.
  const res = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = connect(epmdPort, host, () => sock.write(req));
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("end", () => resolve(Buffer.concat(chunks)));
    sock.on("error", reject);
  });

  if (res.length < 2 || res[0] !== PORT2_RESP) throw new Error("bad reply from EPMD");
  if (res[1] !== 0) throw new Error(`node ${name} is not registered in EPMD on ${host}`);

  const nlen = res.readUInt16BE(10);
  return {
    port: res.readUInt16BE(2),
    nodeType: res[4]!,
    protocol: res[5]!,
    highestVersion: res.readUInt16BE(6),
    lowestVersion: res.readUInt16BE(8),
    name: res.subarray(12, 12 + nlen).toString("utf8"),
  };
}

const ALIVE2_REQ = 120;
const ALIVE2_X_RESP = 118;
const ALIVE2_RESP = 121;

export interface Registration {
  creation: number;
  /** Unregisters the node: EPMD forgets it once this connection closes. */
  close(): void;
}

/**
 * Registers node `name` (the part before `@`) listening on `port` with the
 * local EPMD. The registration lasts while the returned connection is open.
 */
export async function register(name: string, port: number, epmdPort = EPMD_PORT): Promise<Registration> {
  const nameBytes = new TextEncoder().encode(name);
  const body = Buffer.alloc(13 + nameBytes.length);
  body[0] = ALIVE2_REQ;
  body.writeUInt16BE(port, 1);
  body[3] = 77; // node type: normal, as erl_epmd sends even for hidden nodes
  body[4] = 0; // protocol: TCP/IPv4
  body.writeUInt16BE(6, 5); // highest version
  body.writeUInt16BE(6, 7); // lowest version
  body.writeUInt16BE(nameBytes.length, 9);
  body.set(nameBytes, 11);
  body.writeUInt16BE(0, 11 + nameBytes.length); // no extra
  const req = Buffer.alloc(2 + body.length);
  req.writeUInt16BE(body.length, 0);
  body.copy(req, 2);

  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const sock = connect(epmdPort, "127.0.0.1", () => sock.write(req));
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(err);
    };
    sock.on("data", (chunk: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const size = buf[0] === ALIVE2_X_RESP ? 6 : buf[0] === ALIVE2_RESP ? 4 : 0;
      if (size === 0) return fail(new Error("bad reply from EPMD"));
      if (buf.length < size) return;
      if (buf[1] !== 0) return fail(new Error(`EPMD refused to register ${name}, the name is probably taken`));
      done = true;
      const creation = size === 6 ? buf.readUInt32BE(2) : buf.readUInt16BE(2);
      resolve({ creation, close: () => sock.destroy() });
    });
    sock.on("error", fail);
    sock.on("close", () => fail(new Error("EPMD closed the connection")));
  });
}
