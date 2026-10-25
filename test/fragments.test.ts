import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, connect as tcpConnect, type Socket } from "node:net";
import { Connection } from "../src/connection.ts";
import { FrameReader } from "../src/framing.ts";
import { DFLAG } from "../src/handshake.ts";
import { atom, type ErlNode, start, type Term, Tuple, tuple } from "../src/index.ts";
import { COOKIE, inbox, startNode, type TestNode } from "./support/node.ts";

let remote: TestNode;
let node: ErlNode;

beforeAll(async () => {
  remote = await startNode("frag_test");
  node = start({ name: "frag_js@localhost", cookie: COOKIE });
  await node.connect(remote.name);
});

afterAll(async () => {
  await node.close();
  await remote.stop();
});

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

test("BEAM negotiates fragments", async () => {
  expect(node.connection(remote.name)!.fragmented).toBe(true);
});

test("large message from BEAM arrives in fragments and is reassembled", async () => {
  const res = await node.rpc(remote.name, "binary", "copy", [Uint8Array.of(7), 1_000_000]);
  expect(res).toEqual(bytes(1_000_000, 7));
});

test("large message to BEAM", async () => {
  const mb = inbox(node);
  const big = [bytes(300_000, 1), atom("tail"), Array.from({ length: 50_000 }, (_, i) => i)];
  await node.send(["echo", remote.name], tuple(mb.pid, big));
  expect(await mb.receive(undefined, 5000)).toEqual(tuple(atom("echo"), big));
  expect(await node.rpc(remote.name, "erlang", "byte_size", [bytes(1_000_000, 3)])).toBe(1_000_000);
  mb.exit();
});

test("fragments of concurrent senders are kept apart", async () => {
  const mb = inbox(node);
  const size = 2_000_000;
  await node.rpc(remote.name, "Elixir.Helpers", "blast", [mb.pid, [1, 2, 3], size]);
  const got = new Map<Term, Term>();
  for (let i = 0; i < 3; i++) {
    const msg = (await mb.receive(undefined, 10_000)) as Tuple;
    got.set(msg.at(0)!, msg.at(1)!);
  }
  for (const tag of [1, 2, 3]) expect(got.get(tag)).toEqual(bytes(size, tag));
  mb.exit();
});

// Two Connection objects over a local socket pair, to cover both framings
// without BEAM: pass-through for peers without DFLAG_FRAGMENTS.
async function pair(flags: bigint): Promise<[Connection, Connection]> {
  const accepted = new Promise<Socket>((resolve) => {
    const server = createServer((s) => {
      server.close();
      resolve(s);
    }).listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      client = tcpConnect(port, "127.0.0.1");
    });
  });
  let client!: Socket;
  const server = await accepted;
  return [
    new Connection("b@localhost", flags, client, new FrameReader(client)),
    new Connection("a@localhost", flags, server, new FrameReader(server)),
  ];
}

for (const [label, flags] of [
  ["pass-through", 0n],
  ["distribution header", DFLAG.FRAGMENTS],
] as const) {
  test(`${label} framing between two connections`, async () => {
    const [a, b] = await pair(flags);
    expect(a.fragmented).toBe(flags !== 0n);
    const got: [Tuple, Term | undefined][] = [];
    b.onMessage = (c, p) => got.push([c, p]);
    const big = bytes(300_000, 9);
    a.send(tuple(2, atom(""), atom("x")), "small");
    a.send(tuple(2, atom(""), atom("x")), big);
    a.send(tuple(18, atom("no_payload")));
    while (got.length < 3) await Bun.sleep(10);
    expect(got[0]).toEqual([tuple(2, atom(""), atom("x")), new TextEncoder().encode("small")]);
    expect(got[1]![1]).toEqual(big);
    expect(got[2]).toEqual([tuple(18, atom("no_payload")), undefined]);
    a.close();
    b.close();
  });
}
