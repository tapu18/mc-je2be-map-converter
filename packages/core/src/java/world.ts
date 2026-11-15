// Java版ワールドの保存データの読み込み（region、チャンク、スコアボード、storage、エンティティ）。
// 圧縮の展開は呼び出し側から渡す（Node / ゲーム内のどちらでも使えるように）。
import { readNbt, type NbtCompound, type NbtTag } from "../nbt/nbt.ts";

/** region のチャンクの圧縮形式。1=gzip、2=zlib、3=なし、4=LZ4 */
export type Decompress = (kind: "gzip" | "zlib", data: Uint8Array) => Uint8Array;

export class RegionFile {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly decompress: Decompress;

  constructor(bytes: Uint8Array, decompress: Decompress) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.decompress = decompress;
  }

  /** region 内のチャンク座標（0〜31）。チャンクがなければ undefined */
  chunk(localX: number, localZ: number): NbtCompound | undefined {
    if (this.bytes.length < 8192) return undefined;
    const idx = (localX & 31) + (localZ & 31) * 32;
    const entry = this.view.getUint32(idx * 4);
    const offset = (entry >>> 8) * 4096;
    if (offset === 0) return undefined;
    const length = this.view.getUint32(offset);
    const kind = this.bytes[offset + 4]!;
    const body = this.bytes.subarray(offset + 5, offset + 4 + length);
    let raw: Uint8Array;
    if (kind === 1) raw = this.decompress("gzip", body);
    else if (kind === 2) raw = this.decompress("zlib", body);
    else if (kind === 3) raw = body;
    else throw new Error(`unsupported chunk compression ${kind}`);
    return readNbt(raw, "java").tag;
  }
}

// ---- NBT の小道具 ----

export function child(tag: NbtTag | undefined, key: string): NbtTag | undefined {
  return tag?.type === "compound" ? tag.value.get(key) : undefined;
}

/**
 * 26.x 系では、型の混ざったリストの要素が、キーが空文字の compound で包まれて保存される。
 * 例：パレットの `{"": "minecraft:stone"}`。包まれていれば中身を返す。
 */
export function unwrapListElement(tag: NbtTag): NbtTag {
  if (tag.type === "compound" && tag.value.size === 1 && tag.value.has("")) return tag.value.get("")!;
  return tag;
}

/** NBT を JSON にしやすい値に変換する（long は文字列、配列は数値の配列） */
export function nbtToPlain(tag: NbtTag): unknown {
  switch (tag.type) {
    case "compound":
      return Object.fromEntries([...tag.value].map(([k, v]) => [k, nbtToPlain(v)]));
    case "list":
      return tag.value.map((v) => nbtToPlain(unwrapListElement(v)));
    case "long":
      return String(tag.value);
    case "longArray":
      return Array.from(tag.value, (v) => String(v));
    case "byteArray":
    case "intArray":
      return Array.from(tag.value);
    default:
      return tag.value;
  }
}

// ---- ブロック ----

export interface BlockState {
  name: string;
  properties: Record<string, string>;
}

/**
 * ブロックの既定の状態を返す関数。26.x では、状態がすべて既定値のブロックは状態なしの文字列として保存されるため、
 * これで補う（既定値は Java 版サーバーのデータ生成の blocks.json から作る。docs/findings.md）。
 */
export type BlockDefaults = (name: string) => Record<string, string> | undefined;

/**
 * パレットの要素を正規化する。旧形式 Name/Properties、新形式 id/properties、文字列、空キーで包んだ文字列に対応。
 * defaults を渡すと、省かれた状態を既定値で補う。
 */
export function paletteEntry(tag: NbtTag, defaults?: BlockDefaults): BlockState {
  const s = rawPaletteEntry(tag);
  const d = defaults?.(s.name);
  return d ? { name: s.name, properties: { ...d, ...s.properties } } : s;
}

function rawPaletteEntry(tag: NbtTag): BlockState {
  const t = unwrapListElement(tag);
  if (t.type === "string") {
    const [name, rest] = t.value.split("[", 2) as [string, string | undefined];
    const properties: Record<string, string> = {};
    if (rest) for (const kv of rest.replace(/\]$/, "").split(",")) {
      const [k, v] = kv.split("=", 2);
      if (k && v !== undefined) properties[k] = v;
    }
    return { name, properties };
  }
  if (t.type !== "compound") throw new Error(`unexpected palette entry ${t.type}`);
  const name = child(t, "Name") ?? child(t, "id");
  if (name?.type !== "string") throw new Error("palette entry without name");
  const props = child(t, "Properties") ?? child(t, "properties");
  const properties: Record<string, string> = {};
  if (props?.type === "compound") for (const [k, v] of props.value) if (v.type === "string") properties[k] = v.value;
  return { name: name.value, properties };
}

/** チャンクの NBT から、ワールド座標のブロックを読む。範囲外や未生成なら undefined */
export function blockAt(chunk: NbtCompound, x: number, y: number, z: number, defaults?: BlockDefaults): BlockState | undefined {
  const sections = child(chunk, "sections");
  if (sections?.type !== "list") return undefined;
  const sy = Math.floor(y / 16);
  const section = sections.value.find((s) => {
    const yy = child(s, "Y");
    return yy?.type === "byte" && yy.value === sy;
  });
  const states = child(section, "block_states");
  const palette = child(states, "palette");
  if (palette?.type !== "list" || palette.value.length === 0) return undefined;
  if (palette.value.length === 1) return paletteEntry(palette.value[0]!, defaults);
  const data = child(states, "data");
  if (data?.type !== "longArray") throw new Error("block_states without data");
  // 1.16 以降は、1つの long をまたいで詰めない
  const bits = Math.max(4, Math.ceil(Math.log2(palette.value.length)));
  const perLong = Math.floor(64 / bits);
  const index = ((y & 15) * 16 + (z & 15)) * 16 + (x & 15);
  const word = BigInt.asUintN(64, data.value[Math.floor(index / perLong)]!);
  const v = Number((word >> BigInt((index % perLong) * bits)) & ((1n << BigInt(bits)) - 1n));
  const entry = palette.value[v];
  if (!entry) throw new Error(`palette index ${v} out of range`);
  return paletteEntry(entry, defaults);
}

export function blockEntities(chunk: NbtCompound): NbtCompound[] {
  const list = child(chunk, "block_entities");
  return list?.type === "list" ? (list.value.filter((t) => t.type === "compound") as NbtCompound[]) : [];
}

// ---- スコアボード・storage・エンティティ ----

export interface ObjectiveScores {
  objective: string;
  scores: { participant: string; score: number }[];
}

/** data/minecraft/scoreboard.dat（展開済み）を読む */
export function readScoreboard(root: NbtCompound): ObjectiveScores[] {
  const data = child(root, "data");
  const objectives = child(data, "Objectives");
  const scores = child(data, "PlayerScores");
  const out = new Map<string, ObjectiveScores>();
  if (objectives?.type === "list") {
    for (const o of objectives.value) {
      const name = child(o, "Name");
      if (name?.type === "string") out.set(name.value, { objective: name.value, scores: [] });
    }
  }
  if (scores?.type === "list") {
    for (const s of scores.value) {
      const obj = child(s, "Objective");
      const name = child(s, "Name");
      const score = child(s, "Score");
      if (obj?.type !== "string" || name?.type !== "string" || score?.type !== "int") continue;
      const entry = out.get(obj.value) ?? { objective: obj.value, scores: [] };
      entry.scores.push({ participant: name.value, score: score.value });
      out.set(obj.value, entry);
    }
  }
  return [...out.values()];
}

/** data/<名前空間>/command_storage.dat（展開済み）を読み、`名前空間:パス` → 値 を返す */
export function readCommandStorage(namespace: string, root: NbtCompound): Map<string, NbtTag> {
  const contents = child(child(root, "data"), "contents");
  const out = new Map<string, NbtTag>();
  if (contents?.type === "compound") for (const [k, v] of contents.value) out.set(`${namespace}:${k}`, v);
  return out;
}

/** entities/ の region のチャンク（展開済み）からエンティティを読む */
export function chunkEntities(chunk: NbtCompound): NbtCompound[] {
  const list = child(chunk, "Entities");
  return list?.type === "list" ? (list.value.filter((t) => t.type === "compound") as NbtCompound[]) : [];
}
