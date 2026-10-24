// Erlang External Term Format.
// https://www.erlang.org/doc/apps/erts/erl_ext_dist.html

export const VERSION = 131;

const NEW_FLOAT_EXT = 70;
const BIT_BINARY_EXT = 77;
const NEW_PID_EXT = 88;
const NEW_PORT_EXT = 89;
const NEWER_REFERENCE_EXT = 90;
const SMALL_INTEGER_EXT = 97;
const INTEGER_EXT = 98;
const ATOM_EXT = 100;
const SMALL_TUPLE_EXT = 104;
const LARGE_TUPLE_EXT = 105;
const NIL_EXT = 106;
const STRING_EXT = 107;
const LIST_EXT = 108;
const BINARY_EXT = 109;
const SMALL_BIG_EXT = 110;
const LARGE_BIG_EXT = 111;
const NEW_FUN_EXT = 112;
const EXPORT_EXT = 113;
const SMALL_ATOM_EXT = 115;
const MAP_EXT = 116;
const ATOM_UTF8_EXT = 118;
const SMALL_ATOM_UTF8_EXT = 119;
const V4_PORT_EXT = 120;

/** An Erlang atom. Instances are interned: `atom("ok") === atom("ok")`. */
export class Atom {
  private static table = new Map<string, Atom>();

  private constructor(readonly name: string) {}

  static of(name: string): Atom {
    let a = Atom.table.get(name);
    if (!a) {
      a = new Atom(name);
      Atom.table.set(name, a);
    }
    return a;
  }

  toString(): string {
    return this.name;
  }
}

export const atom = (name: string): Atom => Atom.of(name);

export class Tuple {
  readonly elements: Term[];
  constructor(...elements: Term[]) {
    this.elements = elements;
  }
  get length(): number {
    return this.elements.length;
  }
  at(i: number): Term | undefined {
    return this.elements[i];
  }
}

export const tuple = (...elements: Term[]): Tuple => new Tuple(...elements);

export class Pid {
  constructor(
    readonly node: Atom,
    readonly id: number,
    readonly serial: number,
    readonly creation: number,
  ) {}

  equals(other: unknown): boolean {
    return (
      other instanceof Pid &&
      other.node === this.node &&
      other.id === this.id &&
      other.serial === this.serial &&
      other.creation === this.creation
    );
  }

  toString(): string {
    return `#PID<${this.node}.${this.id}.${this.serial}>`;
  }
}

export class Ref {
  constructor(
    readonly node: Atom,
    readonly creation: number,
    readonly ids: readonly number[],
  ) {}

  equals(other: unknown): boolean {
    return (
      other instanceof Ref &&
      other.node === this.node &&
      other.creation === this.creation &&
      other.ids.length === this.ids.length &&
      other.ids.every((id, i) => id === this.ids[i])
    );
  }

  toString(): string {
    return `#Reference<${this.node}.${this.ids.join(".")}>`;
  }
}

export class Port {
  constructor(
    readonly node: Atom,
    readonly id: bigint,
    readonly creation: number,
  ) {}

  toString(): string {
    return `#Port<${this.node}.${this.id}>`;
  }
}

/** A list whose tail is not `[]`, e.g. `[1 | 2]`. `items` is never empty. */
export class ImproperList {
  constructor(
    readonly items: Term[],
    readonly tail: Term,
  ) {}
}

/** A bitstring whose length is not a whole number of bytes. Only the high `bits` bits of the last byte are used. */
export class BitBinary {
  constructor(
    readonly bytes: Uint8Array,
    readonly bits: number,
  ) {}
}

/** An external fun, `&module.function/arity`. */
export class Export {
  constructor(
    readonly module: Atom,
    readonly fn: Atom,
    readonly arity: number,
  ) {}
}

/**
 * A local fun. It can be passed back to the node that created it and called
 * there, but not called from JS.
 */
export class Fun {
  constructor(
    readonly arity: number,
    readonly uniq: Uint8Array,
    readonly index: number,
    readonly module: Atom,
    readonly oldIndex: Term,
    readonly oldUniq: Term,
    readonly pid: Pid,
    readonly freeVars: Term[],
  ) {}
}

/** Forces a number to be encoded as a float, e.g. `float(1)` → `1.0`. */
export class Float {
  constructor(readonly value: number) {}
}

export const float = (value: number): Float => new Float(value);

/**
 * JS view of an Erlang term.
 *
 * Decoding gives: integers as `number` (or `bigint` outside the safe range),
 * floats as `number`, atoms as `Atom` except `true`/`false` which become
 * booleans, binaries as `Uint8Array`, lists as arrays, maps as `Map`.
 *
 * Encoding: safe integers become integers, other numbers become floats
 * (use `float()` to send `1.0`, `bigint` for exact large integers).
 * Strings go out as UTF-8 binaries, plain objects as maps with atom keys.
 */
export type Term =
  | number
  | bigint
  | boolean
  | string
  | Atom
  | Float
  | Uint8Array
  | Tuple
  | Pid
  | Ref
  | Port
  | ImproperList
  | BitBinary
  | Export
  | Fun
  | Term[]
  | Map<Term, Term>
  | { [key: string]: Term };

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const latin1Decoder = new TextDecoder("latin1");

/** Decodes a UTF-8 binary into a string. */
export const binaryToString = (bin: Uint8Array): string => utf8Decoder.decode(bin);

// ---------------------------------------------------------------------------
// Encoding

class Writer {
  private buf = new Uint8Array(64);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private reserve(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number) {
    this.reserve(1);
    this.buf[this.length++] = v;
  }
  u16(v: number) {
    this.reserve(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
  }
  u32(v: number) {
    this.reserve(4);
    this.view.setUint32(this.length, v);
    this.length += 4;
  }
  i32(v: number) {
    this.reserve(4);
    this.view.setInt32(this.length, v);
    this.length += 4;
  }
  f64(v: number) {
    this.reserve(8);
    this.view.setFloat64(this.length, v);
    this.length += 8;
  }
  patchU32(pos: number, v: number) {
    this.view.setUint32(pos, v);
  }
  bytes(b: Uint8Array) {
    this.reserve(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Encodes a term with the leading version byte. */
export function encode(term: Term): Uint8Array {
  const w = new Writer();
  w.u8(VERSION);
  write(w, term);
  return w.result();
}

/** Encodes a term without the version byte, to follow a distribution header. */
export function encodeRaw(term: Term): Uint8Array {
  const w = new Writer();
  write(w, term);
  return w.result();
}

function write(w: Writer, t: Term): void {
  if (typeof t === "number") {
    if (Number.isSafeInteger(t)) writeInteger(w, BigInt(t));
    else writeFloat(w, t);
  } else if (typeof t === "bigint") {
    writeInteger(w, t);
  } else if (typeof t === "boolean") {
    writeAtom(w, t ? "true" : "false");
  } else if (typeof t === "string") {
    writeBinary(w, utf8.encode(t));
  } else if (t instanceof Atom) {
    writeAtom(w, t.name);
  } else if (t instanceof Float) {
    writeFloat(w, t.value);
  } else if (t instanceof Uint8Array) {
    writeBinary(w, t);
  } else if (t instanceof Tuple) {
    const n = t.elements.length;
    if (n < 256) {
      w.u8(SMALL_TUPLE_EXT);
      w.u8(n);
    } else {
      w.u8(LARGE_TUPLE_EXT);
      w.u32(n);
    }
    for (const e of t.elements) write(w, e);
  } else if (Array.isArray(t)) {
    // Like Erlang, short lists of bytes go out as STRING_EXT.
    if (t.length > 0 && t.length <= 0xffff && t.every(isByte)) {
      w.u8(STRING_EXT);
      w.u16(t.length);
      for (const b of t as number[]) w.u8(b);
      return;
    }
    if (t.length > 0) {
      w.u8(LIST_EXT);
      w.u32(t.length);
      for (const e of t) write(w, e);
    }
    w.u8(NIL_EXT);
  } else if (t instanceof Pid) {
    w.u8(NEW_PID_EXT);
    writeAtom(w, t.node.name);
    w.u32(t.id);
    w.u32(t.serial);
    w.u32(t.creation);
  } else if (t instanceof ImproperList) {
    if (t.items.length === 0) throw new TypeError("ImproperList needs at least one item");
    w.u8(LIST_EXT);
    w.u32(t.items.length);
    for (const e of t.items) write(w, e);
    write(w, t.tail);
  } else if (t instanceof BitBinary) {
    w.u8(BIT_BINARY_EXT);
    w.u32(t.bytes.length);
    w.u8(t.bits);
    w.bytes(t.bytes);
  } else if (t instanceof Export) {
    w.u8(EXPORT_EXT);
    write(w, t.module);
    write(w, t.fn);
    writeInteger(w, BigInt(t.arity));
  } else if (t instanceof Fun) {
    const start = w.length;
    w.u8(NEW_FUN_EXT);
    w.u32(0); // size, patched below
    w.u8(t.arity);
    w.bytes(t.uniq);
    w.u32(t.index);
    w.u32(t.freeVars.length);
    write(w, t.module);
    write(w, t.oldIndex);
    write(w, t.oldUniq);
    write(w, t.pid);
    for (const v of t.freeVars) write(w, v);
    w.patchU32(start + 1, w.length - start - 1);
  } else if (t instanceof Port) {
    w.u8(V4_PORT_EXT);
    writeAtom(w, t.node.name);
    w.u32(Number(t.id >> 32n));
    w.u32(Number(t.id & 0xffffffffn));
    w.u32(t.creation);
  } else if (t instanceof Ref) {
    w.u8(NEWER_REFERENCE_EXT);
    w.u16(t.ids.length);
    writeAtom(w, t.node.name);
    w.u32(t.creation);
    for (const id of t.ids) w.u32(id);
  } else if (t instanceof Map) {
    w.u8(MAP_EXT);
    w.u32(t.size);
    for (const [k, v] of t) {
      write(w, k);
      write(w, v);
    }
  } else if (t !== null && typeof t === "object" && Object.getPrototypeOf(t) === Object.prototype) {
    const entries = Object.entries(t);
    w.u8(MAP_EXT);
    w.u32(entries.length);
    for (const [k, v] of entries) {
      writeAtom(w, k);
      write(w, v);
    }
  } else {
    throw new TypeError(`cannot encode ${String(t)} as an Erlang term`);
  }
}

function writeInteger(w: Writer, n: bigint) {
  if (n >= 0n && n <= 255n) {
    w.u8(SMALL_INTEGER_EXT);
    w.u8(Number(n));
  } else if (n >= -(2n ** 31n) && n < 2n ** 31n) {
    w.u8(INTEGER_EXT);
    w.i32(Number(n));
  } else {
    const digits: number[] = [];
    let abs = n < 0n ? -n : n;
    while (abs > 0n) {
      digits.push(Number(abs & 0xffn));
      abs >>= 8n;
    }
    if (digits.length < 256) {
      w.u8(SMALL_BIG_EXT);
      w.u8(digits.length);
    } else {
      w.u8(LARGE_BIG_EXT);
      w.u32(digits.length);
    }
    w.u8(n < 0n ? 1 : 0);
    for (const d of digits) w.u8(d);
  }
}

function writeFloat(w: Writer, v: number) {
  w.u8(NEW_FLOAT_EXT);
  w.f64(v);
}

function writeAtom(w: Writer, name: string) {
  const bytes = utf8.encode(name);
  if (bytes.length < 256) {
    w.u8(SMALL_ATOM_UTF8_EXT);
    w.u8(bytes.length);
  } else {
    w.u8(ATOM_UTF8_EXT);
    w.u16(bytes.length);
  }
  w.bytes(bytes);
}

function writeBinary(w: Writer, b: Uint8Array) {
  w.u8(BINARY_EXT);
  w.u32(b.length);
  w.bytes(b);
}

// ---------------------------------------------------------------------------
// Decoding

export class Reader {
  private view: DataView;
  pos: number;

  constructor(
    readonly buf: Uint8Array,
    pos = 0,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }

  private need(n: number) {
    if (this.pos + n > this.buf.length) throw new RangeError("unexpected end of term");
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
}

/** Decodes a term that starts with the version byte. Trailing bytes are an error. */
export function decode(bytes: Uint8Array): Term {
  const r = new Reader(bytes);
  const term = decodeFrom(r);
  if (r.pos !== bytes.length) throw new Error(`${bytes.length - r.pos} trailing bytes after term`);
  return term;
}

/** Decodes one versioned term at the reader's position and advances it. */
export function decodeFrom(r: Reader): Term {
  const version = r.u8();
  if (version !== VERSION) throw new Error(`unsupported term version ${version}`);
  return read(r);
}

/** Decodes one term without the version byte, as it follows a distribution header. */
export function decodeRaw(r: Reader): Term {
  return read(r);
}

function read(r: Reader): Term {
  const tag = r.u8();
  switch (tag) {
    case SMALL_INTEGER_EXT:
      return r.u8();
    case INTEGER_EXT:
      return r.i32();
    case SMALL_BIG_EXT:
    case LARGE_BIG_EXT: {
      const n = tag === SMALL_BIG_EXT ? r.u8() : r.u32();
      const sign = r.u8();
      const digits = r.bytes(n);
      let v = 0n;
      for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(digits[i]!);
      if (sign) v = -v;
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    case NEW_FLOAT_EXT:
      return r.f64();
    case ATOM_UTF8_EXT:
      return toAtom(utf8Decoder.decode(r.bytes(r.u16())));
    case SMALL_ATOM_UTF8_EXT:
      return toAtom(utf8Decoder.decode(r.bytes(r.u8())));
    case ATOM_EXT:
      return toAtom(latin1Decoder.decode(r.bytes(r.u16())));
    case SMALL_ATOM_EXT:
      return toAtom(latin1Decoder.decode(r.bytes(r.u8())));
    case BINARY_EXT:
      return r.bytes(r.u32()).slice();
    case NIL_EXT:
      return [];
    case STRING_EXT:
      return Array.from(r.bytes(r.u16()));
    case LIST_EXT: {
      const n = r.u32();
      const items: Term[] = new Array(n);
      for (let i = 0; i < n; i++) items[i] = read(r);
      const tail = read(r);
      if (Array.isArray(tail) && tail.length === 0) return items;
      return new ImproperList(items, tail);
    }
    case SMALL_TUPLE_EXT:
    case LARGE_TUPLE_EXT: {
      const n = tag === SMALL_TUPLE_EXT ? r.u8() : r.u32();
      const items: Term[] = new Array(n);
      for (let i = 0; i < n; i++) items[i] = read(r);
      return new Tuple(...items);
    }
    case MAP_EXT: {
      const n = r.u32();
      const map = new Map<Term, Term>();
      for (let i = 0; i < n; i++) {
        const k = read(r);
        map.set(k, read(r));
      }
      return map;
    }
    case BIT_BINARY_EXT: {
      const n = r.u32();
      const bits = r.u8();
      return new BitBinary(r.bytes(n).slice(), bits);
    }
    case EXPORT_EXT: {
      const module = readAtom(r);
      const fn = readAtom(r);
      const arity = read(r);
      if (typeof arity !== "number") throw new Error("expected export arity");
      return new Export(module, fn, arity);
    }
    case NEW_FUN_EXT: {
      const end = r.pos + r.u32();
      const arity = r.u8();
      const uniq = r.bytes(16).slice();
      const index = r.u32();
      const numFree = r.u32();
      const module = readAtom(r);
      const oldIndex = read(r);
      const oldUniq = read(r);
      const pid = read(r);
      if (!(pid instanceof Pid)) throw new Error("expected fun creator pid");
      const freeVars: Term[] = [];
      for (let i = 0; i < numFree; i++) freeVars.push(read(r));
      if (r.pos !== end) throw new Error("fun size does not match its contents");
      return new Fun(arity, uniq, index, module, oldIndex, oldUniq, pid, freeVars);
    }
    case NEW_PORT_EXT: {
      const node = readAtom(r);
      return new Port(node, BigInt(r.u32()), r.u32());
    }
    case V4_PORT_EXT: {
      const node = readAtom(r);
      const id = (BigInt(r.u32()) << 32n) | BigInt(r.u32());
      return new Port(node, id, r.u32());
    }
    case NEW_PID_EXT: {
      const node = readAtom(r);
      return new Pid(node, r.u32(), r.u32(), r.u32());
    }
    case NEWER_REFERENCE_EXT: {
      const n = r.u16();
      const node = readAtom(r);
      const creation = r.u32();
      const ids: number[] = [];
      for (let i = 0; i < n; i++) ids.push(r.u32());
      return new Ref(node, creation, ids);
    }
    default:
      throw new Error(`unsupported term tag ${tag}`);
  }
}

function readAtom(r: Reader): Atom {
  const t = read(r);
  if (t instanceof Atom) return t;
  if (typeof t === "boolean") return Atom.of(String(t));
  throw new Error("expected an atom");
}

function toAtom(name: string): Atom | boolean {
  if (name === "true") return true;
  if (name === "false") return false;
  return Atom.of(name);
}

const isByte = (t: Term): boolean => typeof t === "number" && Number.isInteger(t) && t >= 0 && t <= 255;

/** Renders a term roughly the way Erlang prints it, for messages and debugging. */
export function format(t: Term): string {
  if (typeof t === "string") return JSON.stringify(t);
  if (typeof t === "number" || typeof t === "bigint" || typeof t === "boolean") return String(t);
  if (t instanceof Atom) return /^[a-z][a-zA-Z0-9_@]*$/.test(t.name) ? t.name : `'${t.name.replace(/'/g, "\\'")}'`;
  if (t instanceof Float) return String(t.value);
  if (t instanceof Uint8Array) return `<<${t.join(",")}>>`;
  if (t instanceof Tuple) return `{${t.elements.map(format).join(",")}}`;
  if (Array.isArray(t)) return `[${t.map(format).join(",")}]`;
  if (t instanceof ImproperList) return `[${t.items.map(format).join(",")}|${format(t.tail)}]`;
  if (t instanceof Map) return `#{${[...t].map(([k, v]) => `${format(k)} => ${format(v)}`).join(",")}}`;
  if (t instanceof Pid || t instanceof Ref || t instanceof Port) return t.toString();
  if (t instanceof Export) return `fun ${format(t.module)}:${format(t.fn)}/${t.arity}`;
  if (t instanceof Fun) return `#Fun<${t.module.name}.${t.index}>`;
  if (t instanceof BitBinary) return `<<${t.bytes.join(",")}:${t.bits}>>`;
  return `#{${Object.entries(t).map(([k, v]) => `${k} => ${format(v)}`).join(",")}}`;
}
