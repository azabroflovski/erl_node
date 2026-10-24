import { createHash, randomInt } from "node:crypto";
import type { Socket } from "node:net";
import { frame, type FrameReader } from "./framing.ts";

// Distribution flags, see lib/kernel/include/dist.hrl.
export const DFLAG = {
  EXTENDED_REFERENCES: 0x4n,
  DIST_MONITOR: 0x8n,
  DIST_MONITOR_NAME: 0x20n,
  FUN_TAGS: 0x10n,
  NEW_FUN_TAGS: 0x80n,
  EXTENDED_PIDS_PORTS: 0x100n,
  EXPORT_PTR_TAG: 0x200n,
  BIT_BINARIES: 0x400n,
  NEW_FLOATS: 0x800n,
  SMALL_ATOM_TAGS: 0x4000n,
  UTF8_ATOMS: 0x10000n,
  MAP_TAG: 0x20000n,
  BIG_CREATION: 0x40000n,
  SEND_SENDER: 0x80000n,
  EXIT_PAYLOAD: 0x400000n,
  FRAGMENTS: 0x800000n,
  HANDSHAKE_23: 0x1000000n,
  UNLINK_ID: 0x2000000n,
  MANDATORY_25_DIGEST: 0x4000000n,
  V4_NC: 0x4n << 32n,
} as const;

// Mandatory for OTP 26+: MANDATORY_25_DIGEST stands for the OTP 25 set,
// V4_NC and UNLINK_ID were added in OTP 26. DFLAG_PUBLISHED is not set,
// so we are a hidden node.
export const OUR_FLAGS =
  DFLAG.MANDATORY_25_DIGEST |
  DFLAG.EXTENDED_REFERENCES |
  DFLAG.FUN_TAGS |
  DFLAG.NEW_FUN_TAGS |
  DFLAG.EXTENDED_PIDS_PORTS |
  DFLAG.EXPORT_PTR_TAG |
  DFLAG.BIT_BINARIES |
  DFLAG.NEW_FLOATS |
  DFLAG.UTF8_ATOMS |
  DFLAG.MAP_TAG |
  DFLAG.BIG_CREATION |
  DFLAG.HANDSHAKE_23 |
  DFLAG.V4_NC |
  DFLAG.UNLINK_ID |
  DFLAG.SMALL_ATOM_TAGS |
  DFLAG.SEND_SENDER |
  DFLAG.DIST_MONITOR |
  DFLAG.DIST_MONITOR_NAME |
  DFLAG.EXIT_PAYLOAD |
  DFLAG.FRAGMENTS;

export interface HandshakeResult {
  peerName: string;
  peerFlags: bigint;
  peerCreation: number;
}

export class HandshakeError extends Error {
  /** The status the remote sent when it refused the connection, e.g. `nok`. */
  status?: string;
}

// Handshake frames have a 2-byte length.
async function read(reader: FrameReader, what: string): Promise<Buffer> {
  try {
    return await reader.read(2);
  } catch (err) {
    throw new HandshakeError(`connection closed while waiting for ${what}`, { cause: err });
  }
}

const digest = (cookie: string, challenge: number): Buffer =>
  createHash("md5").update(cookie + String(challenge)).digest();

/**
 * Runs the initiating side of the version 6 handshake on a connected socket.
 * https://www.erlang.org/doc/apps/erts/erl_dist_protocol.html#distribution-handshake
 */
export async function handshake(
  socket: Socket,
  reader: FrameReader,
  opts: { name: string; cookie: string; creation: number },
): Promise<HandshakeResult> {

  // send_name: 'N', Flags:8, Creation:4, NLen:2, Name
  const name = Buffer.from(opts.name, "utf8");
  const sendName = Buffer.alloc(15 + name.length);
  sendName.write("N", 0, "latin1");
  sendName.writeBigUInt64BE(OUR_FLAGS, 1);
  sendName.writeUInt32BE(opts.creation, 9);
  sendName.writeUInt16BE(name.length, 13);
  name.copy(sendName, 15);
  socket.write(frame(2, sendName));

  // recv_status: 's', Status
  const status = await read(reader, "status");
  if (status[0] !== 0x73) throw new HandshakeError("expected status message");
  const statusText = status.subarray(1).toString("latin1");
  if (statusText !== "ok" && statusText !== "ok_simultaneous") {
    const err = new HandshakeError(`remote node refused the connection: ${statusText}`);
    err.status = statusText;
    throw err;
  }

  // recv_challenge: 'N', Flags:8, Challenge:4, Creation:4, NLen:2, Name
  const ch = await read(reader, "challenge");
  if (ch[0] !== 0x4e) throw new HandshakeError("expected a version 6 challenge");
  const peerFlags = ch.readBigUInt64BE(1);
  const challenge = ch.readUInt32BE(9);
  const peerCreation = ch.readUInt32BE(13);
  const peerName = ch.subarray(19, 19 + ch.readUInt16BE(17)).toString("utf8");

  // send_challenge_reply: 'r', Challenge:4, Digest:16
  const ourChallenge = randomInt(0, 2 ** 32);
  const reply = Buffer.alloc(21);
  reply.write("r", 0, "latin1");
  reply.writeUInt32BE(ourChallenge, 1);
  digest(opts.cookie, challenge).copy(reply, 5);
  socket.write(frame(2, reply));

  // recv_challenge_ack: 'a', Digest:16. The remote closes the socket instead
  // if our digest was wrong.
  let ack: Buffer;
  try {
    ack = await reader.read(2);
  } catch (err) {
    throw new HandshakeError("remote node rejected the cookie", { cause: err });
  }
  if (ack[0] !== 0x61) throw new HandshakeError("expected challenge ack");
  if (!ack.subarray(1, 17).equals(digest(opts.cookie, ourChallenge))) {
    throw new HandshakeError("remote node does not know our cookie");
  }

  return { peerName, peerFlags, peerCreation };
}

/** What the accepting side answers to a connection attempt from `peerName`. */
export type AcceptStatus = "ok" | "ok_simultaneous" | "nok" | "alive";

/**
 * Runs the accepting side of the version 6 handshake. `decide` picks the
 * status to send; with `alive` the initiator tells whether it is a new
 * incarnation, and `replace` is called before continuing if it is.
 */
export async function acceptHandshake(
  socket: Socket,
  reader: FrameReader,
  opts: {
    name: string;
    cookie: string;
    creation: number;
    decide: (peerName: string) => AcceptStatus;
    replace: (peerName: string) => void;
  },
): Promise<HandshakeResult> {
  const sendStatus = (status: string) => socket.write(frame(2, Buffer.from("s" + status, "latin1")));

  // recv_name: 'N', Flags:8, Creation:4, NLen:2, Name
  const nm = await read(reader, "name");
  if (nm[0] !== 0x4e) throw new HandshakeError("only version 6 handshakes are supported");
  const peerFlags = nm.readBigUInt64BE(1);
  const peerCreation = nm.readUInt32BE(9);
  const peerName = nm.subarray(15, 15 + nm.readUInt16BE(13)).toString("utf8");
  if ((peerFlags & DFLAG.HANDSHAKE_23) === 0n) {
    sendStatus("not_allowed");
    throw new HandshakeError(`${peerName} does not support handshake version 6`);
  }

  // send_status
  const status = opts.decide(peerName);
  sendStatus(status);
  if (status === "nok") throw new HandshakeError(`refused ${peerName}: connection attempt already in progress`);
  if (status === "alive") {
    const answer = (await read(reader, "alive answer")).toString("latin1");
    if (answer !== "strue") throw new HandshakeError(`refused ${peerName}: already connected`);
    opts.replace(peerName);
  }

  // send_challenge: 'N', Flags:8, Challenge:4, Creation:4, NLen:2, Name
  const ourChallenge = randomInt(0, 2 ** 32);
  const name = Buffer.from(opts.name, "utf8");
  const ch = Buffer.alloc(19 + name.length);
  ch.write("N", 0, "latin1");
  ch.writeBigUInt64BE(OUR_FLAGS, 1);
  ch.writeUInt32BE(ourChallenge, 9);
  ch.writeUInt32BE(opts.creation, 13);
  ch.writeUInt16BE(name.length, 17);
  name.copy(ch, 19);
  socket.write(frame(2, ch));

  // recv_challenge_reply: 'r', Challenge:4, Digest:16
  const reply = await read(reader, "challenge reply");
  if (reply[0] !== 0x72 || reply.length !== 21) throw new HandshakeError("expected challenge reply");
  if (!reply.subarray(5, 21).equals(digest(opts.cookie, ourChallenge))) {
    throw new HandshakeError(`${peerName} does not know our cookie`);
  }

  // send_challenge_ack: 'a', Digest:16
  const ack = Buffer.alloc(17);
  ack.write("a", 0, "latin1");
  digest(opts.cookie, reply.readUInt32BE(1)).copy(ack, 1);
  socket.write(frame(2, ack));

  return { peerName, peerFlags, peerCreation };
}
