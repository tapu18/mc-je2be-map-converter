// SNBT（文字列で書いた NBT）の読み取り。コマンドの NBT 引数、テキスト（1.21.5 以降の SNBT 形式と、
// それ以前の JSON 形式）、データコンポーネントの値に使う。
//
// 1.21.5 で SNBT の文法が広がった（16進・2進の整数、符号の接尾辞、\n などのエスケープ、
// 型の混ざったリスト、bool() / uuid()）。ここでは両方を受け付ける上位集合として読む。
// そのため「ここで読めた」ことは「その版の Java で読める」ことを意味しない（未確認、#13）。
import type { NbtTag, NbtTagType } from "../nbt/nbt.ts";
import { StringReader } from "./reader.ts";

const isUnquotedChar = (c: string): boolean =>
  (c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "-" || c === "." || c === "+";

export function parseSnbt(input: string): NbtTag {
  const r = new StringReader(input);
  const tag = readSnbtValue(r);
  r.skipWhitespace();
  if (r.canRead()) throw r.error("SNBT の後ろに余分な文字がある");
  return tag;
}

export function readSnbtCompound(r: StringReader): Extract<NbtTag, { type: "compound" }> {
  r.skipWhitespace();
  if (r.peek() !== "{") throw r.error("'{' が必要");
  const tag = readSnbtValue(r);
  return tag as Extract<NbtTag, { type: "compound" }>;
}

export function readSnbtValue(r: StringReader): NbtTag {
  r.skipWhitespace();
  if (!r.canRead()) throw r.error("値が必要");
  const c = r.peek();
  if (c === "{") return readCompound(r);
  if (c === "[") return readListOrArray(r);
  if (c === '"' || c === "'") return { type: "string", value: readQuoted(r) };
  return readPrimitive(r);
}

function readKey(r: StringReader): string {
  r.skipWhitespace();
  const c = r.peek();
  if (c === '"' || c === "'") return readQuoted(r);
  const start = r.cursor;
  const key = r.readWhile(isUnquotedChar);
  if (!key) throw r.error("キーが必要", start);
  return key;
}

function readCompound(r: StringReader): NbtTag {
  r.expect("{");
  const value = new Map<string, NbtTag>();
  r.skipWhitespace();
  while (r.canRead() && r.peek() !== "}") {
    const key = readKey(r);
    r.skipWhitespace();
    r.expect(":");
    value.set(key, readSnbtValue(r));
    r.skipWhitespace();
    if (r.peek() === ",") {
      r.skip();
      r.skipWhitespace();
    } else break;
  }
  r.skipWhitespace();
  r.expect("}");
  return { type: "compound", value };
}

function readListOrArray(r: StringReader): NbtTag {
  r.expect("[");
  const p = r.peek();
  if ((p === "B" || p === "I" || p === "L") && r.peek(1) === ";") {
    r.skip(2);
    const items: NbtTag[] = readElements(r);
    if (p === "B") return { type: "byteArray", value: Int8Array.from(items.map((t) => numberOf(t, r))) };
    if (p === "I") return { type: "intArray", value: Int32Array.from(items.map((t) => numberOf(t, r))) };
    return { type: "longArray", value: BigInt64Array.from(items.map((t) => (t.type === "long" ? t.value : BigInt(numberOf(t, r))))) };
  }
  const items = readElements(r);
  return makeList(items);
}

function readElements(r: StringReader): NbtTag[] {
  const items: NbtTag[] = [];
  r.skipWhitespace();
  while (r.canRead() && r.peek() !== "]") {
    items.push(readSnbtValue(r));
    r.skipWhitespace();
    if (r.peek() === ",") {
      r.skip();
      r.skipWhitespace();
    } else break;
  }
  r.skipWhitespace();
  r.expect("]");
  return items;
}

function numberOf(t: NbtTag, r: StringReader): number {
  if (t.type === "byte" || t.type === "short" || t.type === "int" || t.type === "float" || t.type === "double") return t.value;
  if (t.type === "long") return Number(t.value);
  throw r.error(`数値が必要（${t.type}）`);
}

/**
 * 型が混ざったリストは、複合タグ以外の要素をキー "" の複合タグに包む（1.21.5 以降の Java の保存形式。
 * 未確認、#13）
 */
function makeList(items: NbtTag[]): NbtTag {
  const types = new Set(items.map((t) => t.type));
  if (types.size <= 1) return { type: "list", elementType: (items[0]?.type ?? "end") as NbtTagType, value: items };
  return {
    type: "list",
    elementType: "compound",
    value: items.map((t) => (t.type === "compound" ? t : { type: "compound", value: new Map([["", t]]) })),
  };
}

const ESCAPES: Record<string, string> = { b: "\b", s: " ", t: "\t", n: "\n", f: "\f", r: "\r", "\\": "\\", '"': '"', "'": "'" };

function readQuoted(r: StringReader): string {
  const quote = r.read();
  let out = "";
  while (r.canRead()) {
    const c = r.read();
    if (c === quote) return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = r.read();
    if (e in ESCAPES) out += ESCAPES[e];
    else if (e === "x" || e === "u" || e === "U") {
      const n = e === "x" ? 2 : e === "u" ? 4 : 8;
      const hex = r.input.slice(r.cursor, r.cursor + n);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) throw r.error(`不正なエスケープ '\\${e}${hex}'`);
      r.skip(n);
      out += String.fromCodePoint(parseInt(hex, 16));
    } else if (e === "N" && r.peek() === "{") {
      const end = r.input.indexOf("}", r.cursor);
      if (end < 0) throw r.error("\\N{...} が閉じていない");
      // 文字の名前を引く表は持たない。名前のまま残す
      out += `\\N${r.input.slice(r.cursor, end + 1)}`;
      r.cursor = end + 1;
    } else throw r.error(`不正なエスケープ '\\${e}'`, r.cursor - 1);
  }
  throw r.error("引用符が閉じていない");
}

const INT_PATTERN = /^([+-]?)(0x[0-9a-fA-F_]+|0b[01_]+|[0-9][0-9_]*)((?:[su](?=[bsil]))?)([bsil]?)$/i;
const FLOAT_PATTERN = /^[+-]?(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(e[+-]?\d[\d_]*)?([fd]?)$/i;

function readPrimitive(r: StringReader): NbtTag {
  const start = r.cursor;
  const word = r.readWhile(isUnquotedChar);
  if (!word) throw r.error(`値が必要（'${r.peek()}'）`, start);
  // bool(...) / uuid(...)（1.21.5 以降）
  if ((word === "bool" || word === "uuid") && r.peek() === "(") {
    r.skip();
    const arg = readSnbtValue(r);
    r.skipWhitespace();
    r.expect(")");
    if (word === "bool") return { type: "byte", value: arg.type === "string" ? 0 : numberOf(arg, r) !== 0 ? 1 : 0 };
    const ints = arg.type === "string" ? uuidToInts(arg.value) : undefined;
    if (!ints) throw r.error("uuid() の引数は UUID の文字列", start);
    return { type: "intArray", value: ints };
  }
  const lower = word.toLowerCase();
  if (lower === "true") return { type: "byte", value: 1 };
  if (lower === "false") return { type: "byte", value: 0 };
  const num = parseNumber(word);
  return num ?? { type: "string", value: word };
}

/** 数値として読めればタグを返す。読めなければ undefined（引用符なしの文字列として扱う） */
export function parseNumber(word: string): NbtTag | undefined {
  const im = INT_PATTERN.exec(word);
  if (im) {
    const [, sign = "", body = "", , suffix = ""] = im;
    const digits = body.replace(/_/g, "");
    const n = BigInt(sign === "-" ? `-${digits}` : digits);
    const kind = suffix.toLowerCase();
    if (kind === "l") return { type: "long", value: n };
    const v = Number(n);
    if (kind === "b") return { type: "byte", value: v };
    if (kind === "s") return { type: "short", value: v };
    return { type: "int", value: v };
  }
  const fm = FLOAT_PATTERN.exec(word);
  if (fm && /\d/.test(word)) {
    const suffix = (fm[3] ?? "").toLowerCase();
    const v = Number(word.replace(/_/g, "").replace(/[fd]$/i, ""));
    if (Number.isNaN(v)) return undefined;
    // 接尾辞なしで小数点も指数もない数は整数として上で拾われるため、ここは double か float
    return { type: suffix === "f" ? "float" : "double", value: v };
  }
  return undefined;
}

/** Java の UUID.fromString と同じく、5つの16進の組（桁数は可変）を受け付ける */
export function uuidToInts(s: string): Int32Array | undefined {
  const parts = s.split("-");
  if (parts.length !== 5 || parts.some((p) => !/^[0-9a-fA-F]{1,16}$/.test(p))) return undefined;
  const [a, b, c, d, e] = parts.map((p) => BigInt(`0x${p}`)) as [bigint, bigint, bigint, bigint, bigint];
  const mask64 = (1n << 64n) - 1n;
  const most = ((a << 32n) | ((b & 0xffffn) << 16n) | (c & 0xffffn)) & mask64;
  const least = (((d & 0xffffn) << 48n) | (e & 0xffffffffffffn)) & mask64;
  return Int32Array.from([most >> 32n, most & 0xffffffffn, least >> 32n, least & 0xffffffffn].map((v) => Number(BigInt.asIntN(32, v))));
}
