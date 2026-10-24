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
