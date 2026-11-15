// NBTの読み書き。JE（ビッグエンディアン、Modified UTF-8）とBE（リトルエンディアン、UTF-8）の両方を扱う。
// ゲーム内でも動かすため、Node の Buffer や TextEncoder には依存しない。

export type NbtTag =
  | { type: "byte"; value: number }
  | { type: "short"; value: number }
  | { type: "int"; value: number }
  | { type: "long"; value: bigint }
  | { type: "float"; value: number }
  | { type: "double"; value: number }
  | { type: "byteArray"; value: Int8Array }
  | { type: "string"; value: string }
  | { type: "list"; elementType: NbtTagType; value: NbtTag[] }
  | { type: "compound"; value: Map<string, NbtTag> }
  | { type: "intArray"; value: Int32Array }
  | { type: "longArray"; value: BigInt64Array };

export type NbtTagType = NbtTag["type"] | "end";
export type NbtCompound = Extract<NbtTag, { type: "compound" }>;

export type Edition = "java" | "bedrock";

const TYPE_IDS: Record<NbtTagType, number> = {
  end: 0, byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6,
  byteArray: 7, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12,
};
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPE_IDS).map(([k, v]) => [v, k])) as Record<number, NbtTagType>;

export interface NamedRoot {
  name: string;
  tag: NbtCompound;
}

// ---- 文字列 ----

function encodeString(s: string, edition: Edition): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (edition === "bedrock" && c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c !== 0 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); // JEではU+0000も2バイト
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  if (edition === "bedrock") {
    // BEは標準のUTF-8。U+0000は1バイト
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === 0xc0 && out[i + 1] === 0x80) out.splice(i, 2, 0);
    }
  }
  return Uint8Array.from(out);
}

function decodeString(bytes: Uint8Array): string {
  // 標準UTF-8とModified UTF-8のどちらも同じ手順で読める（サロゲートの3バイト表現もそのまま連結される）
  let s = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    let c: number;
    if (b < 0x80) { c = b; i += 1; }
    else if (b < 0xe0) { c = ((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f); i += 2; }
    else if (b < 0xf0) { c = ((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f); i += 3; }
    else {
      c = ((b & 0x07) << 18) | ((bytes[i + 1]! & 0x3f) << 12) | ((bytes[i + 2]! & 0x3f) << 6) | (bytes[i + 3]! & 0x3f);
      i += 4;
    }
    s += String.fromCodePoint(c);
  }
  return s;
}

// ---- 読み込み ----

class Reader {
  private readonly bytes: Uint8Array;
  private readonly le: boolean;
  private readonly view: DataView;
  pos = 0;
  constructor(bytes: Uint8Array, le: boolean) {
    this.bytes = bytes;
    this.le = le;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number { return this.view.getUint8(this.pos++); }
  i8(): number { return this.view.getInt8(this.pos++); }
  i16(): number { const v = this.view.getInt16(this.pos, this.le); this.pos += 2; return v; }
  u16(): number { const v = this.view.getUint16(this.pos, this.le); this.pos += 2; return v; }
  i32(): number { const v = this.view.getInt32(this.pos, this.le); this.pos += 4; return v; }
  i64(): bigint { const v = this.view.getBigInt64(this.pos, this.le); this.pos += 8; return v; }
  f32(): number { const v = this.view.getFloat32(this.pos, this.le); this.pos += 4; return v; }
  f64(): number { const v = this.view.getFloat64(this.pos, this.le); this.pos += 8; return v; }
  str(): string {
    const len = this.u16();
    const v = decodeString(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return v;
  }
  payload(type: NbtTagType): NbtTag {
    switch (type) {
      case "byte": return { type, value: this.i8() };
      case "short": return { type, value: this.i16() };
      case "int": return { type, value: this.i32() };
      case "long": return { type, value: this.i64() };
      case "float": return { type, value: this.f32() };
      case "double": return { type, value: this.f64() };
      case "string": return { type, value: this.str() };
      case "byteArray": {
        const n = this.i32();
        const v = Int8Array.from(this.bytes.subarray(this.pos, this.pos + n));
        this.pos += n;
        return { type, value: v };
      }
      case "intArray": {
        const n = this.i32();
        const v = new Int32Array(n);
        for (let i = 0; i < n; i++) v[i] = this.i32();
        return { type, value: v };
      }
      case "longArray": {
        const n = this.i32();
        const v = new BigInt64Array(n);
        for (let i = 0; i < n; i++) v[i] = this.i64();
        return { type, value: v };
      }
      case "list": {
        const elementType = typeName(this.u8());
        const n = this.i32();
        const value: NbtTag[] = [];
        for (let i = 0; i < n; i++) value.push(this.payload(elementType));
        return { type, elementType, value };
      }
      case "compound": {
        const value = new Map<string, NbtTag>();
        for (;;) {
          const t = typeName(this.u8());
          if (t === "end") break;
          const name = this.str();
          value.set(name, this.payload(t));
        }
        return { type, value };
      }
      case "end":
        throw new Error("unexpected TAG_End");
    }
  }
}

function typeName(id: number): NbtTagType {
  const t = TYPE_NAMES[id];
  if (t === undefined) throw new Error(`unknown NBT tag id ${id}`);
  return t;
}

/** 名前付きルートのcompoundを1つ読む。圧縮は呼び出し側で解く。 */
export function readNbt(bytes: Uint8Array, edition: Edition): NamedRoot & { length: number } {
  const r = new Reader(bytes, edition === "bedrock");
  const t = typeName(r.u8());
  if (t !== "compound") throw new Error(`root tag must be compound, got ${t}`);
  const name = r.str();
  const tag = r.payload("compound") as NbtCompound;
  return { name, tag, length: r.pos };
}

/** BEの .mcstructure のように、ルートcompoundが連続して並ぶデータを読む。 */
export function readNbtSequence(bytes: Uint8Array, edition: Edition): NamedRoot[] {
  const out: NamedRoot[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const { name, tag, length } = readNbt(bytes.subarray(pos), edition);
    out.push({ name, tag });
    pos += length;
  }
  return out;
}

// ---- 書き込み ----

class Writer {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  pos = 0;
  private readonly le: boolean;
  private readonly edition: Edition;
  constructor(le: boolean, edition: Edition) {
    this.le = le;
    this.edition = edition;
  }
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void { this.ensure(1); this.view.setUint8(this.pos++, v); }
  i8(v: number): void { this.ensure(1); this.view.setInt8(this.pos++, v); }
  i16(v: number): void { this.ensure(2); this.view.setInt16(this.pos, v, this.le); this.pos += 2; }
  u16(v: number): void { this.ensure(2); this.view.setUint16(this.pos, v, this.le); this.pos += 2; }
  i32(v: number): void { this.ensure(4); this.view.setInt32(this.pos, v, this.le); this.pos += 4; }
  i64(v: bigint): void { this.ensure(8); this.view.setBigInt64(this.pos, v, this.le); this.pos += 8; }
  f32(v: number): void { this.ensure(4); this.view.setFloat32(this.pos, v, this.le); this.pos += 4; }
  f64(v: number): void { this.ensure(8); this.view.setFloat64(this.pos, v, this.le); this.pos += 8; }
  bytes(b: Uint8Array): void { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  str(s: string): void {
    const b = encodeString(s, this.edition);
    if (b.length > 0xffff) throw new Error("NBT string too long");
    this.u16(b.length);
    this.bytes(b);
  }
  payload(tag: NbtTag): void {
    switch (tag.type) {
      case "byte": return this.i8(tag.value);
      case "short": return this.i16(tag.value);
      case "int": return this.i32(tag.value);
      case "long": return this.i64(tag.value);
      case "float": return this.f32(tag.value);
      case "double": return this.f64(tag.value);
      case "string": return this.str(tag.value);
      case "byteArray":
        this.i32(tag.value.length);
        return this.bytes(new Uint8Array(tag.value.buffer, tag.value.byteOffset, tag.value.length));
      case "intArray":
        this.i32(tag.value.length);
        for (const v of tag.value) this.i32(v);
        return;
      case "longArray":
        this.i32(tag.value.length);
        for (const v of tag.value) this.i64(v);
        return;
      case "list": {
        const elementType = tag.value.length === 0 ? tag.elementType : tag.value[0]!.type;
        this.u8(TYPE_IDS[elementType]);
        this.i32(tag.value.length);
        for (const v of tag.value) {
          if (v.type !== elementType) throw new Error(`mixed list element types: ${elementType} and ${v.type}`);
          this.payload(v);
        }
        return;
      }
      case "compound":
        for (const [name, v] of tag.value) {
          this.u8(TYPE_IDS[v.type]);
          this.str(name);
          this.payload(v);
        }
        return this.u8(0);
    }
  }
  result(): Uint8Array { return this.buf.slice(0, this.pos); }
}

export function writeNbt(root: NamedRoot, edition: Edition): Uint8Array {
  const w = new Writer(edition === "bedrock", edition);
  w.u8(TYPE_IDS.compound);
  w.str(root.name);
  w.payload(root.tag);
  return w.result();
}

// ---- BEの level.dat ----
// 先頭8バイト（ストレージバージョンとNBT本体の長さ、どちらもリトルエンディアンのint32）＋NBT本体

export interface BedrockLevelDat {
  storageVersion: number;
  root: NamedRoot;
}

export function readBedrockLevelDat(bytes: Uint8Array): BedrockLevelDat {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const storageVersion = view.getInt32(0, true);
  const length = view.getInt32(4, true);
  const { name, tag } = readNbt(bytes.subarray(8, 8 + length), "bedrock");
  return { storageVersion, root: { name, tag } };
}

export function writeBedrockLevelDat(dat: BedrockLevelDat): Uint8Array {
  const body = writeNbt(dat.root, "bedrock");
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setInt32(0, dat.storageVersion, true);
  view.setInt32(4, body.length, true);
  out.set(body, 8);
  return out;
}

// ---- 組み立て用の小道具 ----

export const nbt = {
  byte: (value: number): NbtTag => ({ type: "byte", value }),
  short: (value: number): NbtTag => ({ type: "short", value }),
  int: (value: number): NbtTag => ({ type: "int", value }),
  long: (value: bigint): NbtTag => ({ type: "long", value }),
  float: (value: number): NbtTag => ({ type: "float", value }),
  double: (value: number): NbtTag => ({ type: "double", value }),
  string: (value: string): NbtTag => ({ type: "string", value }),
  list: (elementType: NbtTagType, value: NbtTag[]): NbtTag => ({ type: "list", elementType, value }),
  compound: (entries: Record<string, NbtTag> | Map<string, NbtTag>): NbtCompound => ({
    type: "compound",
    value: entries instanceof Map ? entries : new Map(Object.entries(entries)),
  }),
};
