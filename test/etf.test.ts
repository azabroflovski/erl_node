import { beforeAll, describe, expect, test } from "bun:test";
import {
  atom,
  binaryToString,
  BitBinary,
  decode,
  encode,
  Export,
  float,
  Fun,
  ImproperList,
  Pid,
  Port,
  Ref,
  toJS,
  Tuple,
  tuple,
} from "../src/etf.ts";
import { runElixir } from "./support/node.ts";

// Terms are rendered by Elixir itself; each one must survive decode → encode
// byte for byte. `minor_version: 2` asks for UTF-8 atoms, the default since
// OTP 26; older releases write latin-1 atoms otherwise. Integral floats are left out: they decode to plain numbers
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
  "2 ** 2100",
  "-(2 ** 2100)",
  "[1 | 2]",
  "[:a, [] | :c]",
  "[1, 2 | <<3>>]",
  "<<1::3>>",
  "<<255, 1::1>>",
  "&:lists.seq/2",
  "&Enum.map/2",
  "fn -> :ok end",
  "(fn x -> fn y -> {x, y} end end).({:free, self(), [1 | 2]})",
  "hd(Port.list())",
];

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let rendered: string[];

beforeAll(async () => {
  const code = `
    for t <- [${TERMS.join(", ")}] do
      IO.puts(Base.encode16(:erlang.term_to_binary(t, minor_version: 2), case: :lower))
    end
  `;
  rendered = (await runElixir(code, ["--sname", "etf_probe@localhost"])).trim().split("\n");
});

describe("roundtrip against :erlang.term_to_binary", () => {
  TERMS.forEach((src, i) => {
    test(src.length > 50 ? src.slice(0, 50) + "…" : src, () => {
      const bytes = Buffer.from(rendered[i]!, "hex");
      // Before OTP 26 ports are NEW_PORT_EXT (89); we always write V4_PORT_EXT, like OTP 26+.
      if (bytes[1] === 89) expect(decode(encode(decode(bytes)))).toEqual(decode(bytes));
      else expect(hex(encode(decode(bytes)))).toBe(hex(bytes));
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

  test("newer shapes", () => {
    const at = (src: string) => decode(Buffer.from(rendered[TERMS.indexOf(src)]!, "hex"));
    expect(at("[1 | 2]")).toEqual(new ImproperList([1], 2));
    expect(at("<<255, 1::1>>")).toEqual(new BitBinary(new Uint8Array([255, 0x80]), 1));
    expect(at("&:lists.seq/2")).toEqual(new Export(atom("lists"), atom("seq"), 2));
    expect(at("hd(Port.list())")).toBeInstanceOf(Port);
    const fun = at("(fn x -> fn y -> {x, y} end end).({:free, self(), [1 | 2]})") as Fun;
    expect(fun).toBeInstanceOf(Fun);
    expect(fun.arity).toBe(1);
    expect(fun.freeVars).toHaveLength(1);
    expect(at("2 ** 2100")).toBe(2n ** 2100n);
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
      `IO.puts(Base.encode16(:erlang.term_to_binary({:ok, "hi", 1.0, %{"a" => 1}, %{"k" => [:x]}, false, -(2 ** 70)}, minor_version: 2), case: :lower))`,
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

  test("null is nil", async () => {
    expect(encode(null)).toEqual(encode(atom("nil")));
    const out = await runElixir(`IO.inspect(:erlang.binary_to_term(Base.decode16!("${hex(encode({ a: null }))}", case: :lower)))`);
    expect(out.trim()).toBe('%{"a" => nil}');
  });

  test("object keys become strings, atom keys need a Map with atom()", async () => {
    const bytes = encode([{ name: "Bob", nested: { ok: true } }, new Map([[atom("name"), "Bob"]])]);
    const out = await runElixir(`IO.inspect(:erlang.binary_to_term(Base.decode16!("${hex(bytes)}", case: :lower)))`);
    expect(out.trim()).toBe('[%{"name" => "Bob", "nested" => %{"ok" => true}}, %{name: "Bob"}]');
  });

  test("rejects what it cannot encode", () => {
    expect(() => encode(undefined as never)).toThrow("cannot encode");
  });
});

describe("toJS", () => {
  test("turns an Elixir term into plain JS data", async () => {
    const src = `%{
      name: "Bob",
      age: 30,
      score: 1.5,
      admin: false,
      manager: nil,
      tags: [:a, "b"],
      point: {1, 2},
      raw: <<255, 0>>,
      nested: %{"key" => %{1 => :one}},
      owner: self()
    }`;
    const out = await runElixir(`IO.puts(Base.encode16(:erlang.term_to_binary(${src}), case: :lower))`);
    const js = toJS(decode(Buffer.from(out.trim(), "hex"))) as Record<string, unknown>;
    const { owner, ...rest } = js;
    expect(rest).toEqual({
      name: "Bob",
      age: 30,
      score: 1.5,
      admin: false,
      manager: null,
      tags: ["a", "b"],
      point: [1, 2],
      raw: new Uint8Array([255, 0]),
      nested: { key: { 1: "one" } },
    });
    expect(owner).toBeInstanceOf(Pid);
    expect(JSON.parse(JSON.stringify(rest.nested))).toEqual({ key: { "1": "one" } });
  });

  test("maps with keys that are not strings stay Maps", () => {
    const m = toJS(new Map([[tuple(1, 2), atom("x")]])) as Map<unknown, unknown>;
    expect(m).toBeInstanceOf(Map);
    expect([...m]).toEqual([[[1, 2], "x"]]);
  });
});
