import { beforeAll, describe, expect, test } from "bun:test";
import { atom, binaryToString, decode, encode, float, Pid, Ref, Tuple, tuple } from "../src/etf.ts";
import { runElixir } from "./support/node.ts";

// Terms are rendered by Elixir itself; each one must survive decode → encode
// byte for byte. Integral floats are left out: they decode to plain numbers
// and go back out as integers (see the `float()` test below).
const TERMS = [
  ":ok",
  "true",
  "false",
  "nil",
  ':"héllo"',
  "String.to_atom(String.duplicate(\"a\", 255))",
  "String.to_atom(String.duplicate(\"я\", 200))",
  "0",
  "255",
  "256",
  "-1",
  "2147483647",
  "-2147483648",
  "2147483648",
  "2 ** 40",
  "-(2 ** 70)",
  "2 ** 64 - 1",
  "1.5",
  "-0.1",
  "1.0e300",
  '""',
  '"hello"',
  '"привет"',
  "<<0, 255, 1>>",
  "[]",
  "~c\"abc\"",
  "[1, 2, 300]",
  "[:a, \"b\", [1]]",
  "{}",
  "{:ok, 1}",
  "List.to_tuple(Enum.to_list(1..300))",
  "%{}",
  "%{a: 1, b: [2]}",
  '%{"k" => {1, 2}, 1 => :x}',
  "self()",
  "make_ref()",
  "{self(), make_ref(), %{ref: make_ref()}}",
  "Enum.to_list(1..70000)",
];

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let rendered: string[];

beforeAll(async () => {
  const code = `
    for t <- [${TERMS.join(", ")}] do
      IO.puts(Base.encode16(:erlang.term_to_binary(t), case: :lower))
    end
  `;
  rendered = (await runElixir(code, ["--sname", "etf_probe@localhost"])).trim().split("\n");
});

describe("roundtrip against :erlang.term_to_binary", () => {
  TERMS.forEach((src, i) => {
    test(src.length > 50 ? src.slice(0, 50) + "…" : src, () => {
      const bytes = Buffer.from(rendered[i]!, "hex");
      expect(hex(encode(decode(bytes)))).toBe(hex(bytes));
    });
  });
});

describe("decode", () => {
  test("JS values", async () => {
    const term = decode(Buffer.from(rendered[TERMS.indexOf("{self(), make_ref(), %{ref: make_ref()}}")]!, "hex"));
    expect(term).toBeInstanceOf(Tuple);
    const [pid, ref, map] = (term as Tuple).elements;
    expect(pid).toBeInstanceOf(Pid);
    expect((pid as Pid).node).toBe(atom("etf_probe@localhost"));
    expect(ref).toBeInstanceOf(Ref);
    expect((map as Map<unknown, unknown>).get(atom("ref"))).toBeInstanceOf(Ref);

    expect(decode(Buffer.from(rendered[TERMS.indexOf("true")]!, "hex"))).toBe(true);
    expect(decode(Buffer.from(rendered[TERMS.indexOf("2 ** 64 - 1")]!, "hex"))).toBe(2n ** 64n - 1n);
    expect(decode(Buffer.from(rendered[TERMS.indexOf("2 ** 40")]!, "hex"))).toBe(2 ** 40);
    expect(decode(Buffer.from(rendered[TERMS.indexOf("~c\"abc\"")]!, "hex"))).toEqual([97, 98, 99]);
    const bin = decode(Buffer.from(rendered[TERMS.indexOf('"привет"')]!, "hex"));
    expect(binaryToString(bin as Uint8Array)).toBe("привет");
  });

  test("old latin-1 atoms", () => {
    // ATOM_EXT and SMALL_ATOM_EXT are no longer produced by OTP 26+, so the bytes are written by hand.
    expect(decode(new Uint8Array([131, 100, 0, 2, 111, 107]))).toBe(atom("ok"));
    expect(decode(new Uint8Array([131, 115, 2, 0xe9, 0x65]))).toBe(atom("ée"));
  });

  test("errors", () => {
    expect(() => decode(new Uint8Array([130, 97, 1]))).toThrow("version");
    expect(() => decode(new Uint8Array([131, 109, 0, 0, 0, 5, 1]))).toThrow("end of term");
    expect(() => decode(new Uint8Array([131, 97, 1, 2]))).toThrow("trailing");
  });
});

describe("encode matches Elixir", () => {
  test("JS-only shapes", async () => {
    const ours = hex(
      encode(tuple(atom("ok"), "hi", float(1), { a: 1 }, new Map([["k", [atom("x")]]]), false, -(2n ** 70n))),
    );
    const theirs = await runElixir(
      `IO.puts(Base.encode16(:erlang.term_to_binary({:ok, "hi", 1.0, %{a: 1}, %{"k" => [:x]}, false, -(2 ** 70)}), case: :lower))`,
    );
    expect(ours).toBe(theirs.trim());
  });

  test("Elixir decodes what we encode", async () => {
    const bytes = encode(tuple(atom("ok"), "héllo", [1, 2, 3], 2n ** 100n));
    const out = await runElixir(
      `IO.inspect(:erlang.binary_to_term(Base.decode16!("${hex(bytes)}", case: :lower)))`,
    );
    expect(out.trim()).toBe(`{:ok, "héllo", [1, 2, 3], ${2n ** 100n}}`);
  });

  test("rejects what it cannot encode", () => {
    expect(() => encode(null as never)).toThrow("cannot encode");
    expect(() => encode(undefined as never)).toThrow("cannot encode");
  });
});
