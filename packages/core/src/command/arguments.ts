// 引数の型（commands.json の parser）ごとの読み取り。
// 文法の木（どの引数がどこに来るか）は Java 版サーバーのデータ生成の commands.json から取り、
// 個々の引数の中身の書き方はここで実装する。レジストリ（ID が実在するか）は確かめない。
import type { NbtCompound, NbtTag } from "../nbt/nbt.ts";
import { StringReader } from "./reader.ts";
import { readSnbtCompound, readSnbtValue, uuidToInts } from "./snbt.ts";

export type TextFormat = "json" | "snbt";

export interface ArgumentOptions {
  /** テキスト（minecraft:component）の書き方。1.21.5 より前は JSON、以降は SNBT */
  textFormat: TextFormat;
  /** 文法を生成した Java リリース。省略時は現行のアイテム引数を読む。 */
  version?: string;
}

export interface Coordinate {
  /** absolute：数値、relative：`~`、local：`^` */
  kind: "absolute" | "relative" | "local";
  value: number;
}

export interface Range {
  min?: number;
  max?: number;
}

export interface SelectorArgument {
  key: string;
  negated: boolean;
  value: SelectorValue;
}

export type SelectorValue =
  | { kind: "number"; value: number }
  | { kind: "range"; range: Range }
  | { kind: "string"; value: string }
  | { kind: "resource"; id: string; tag: boolean }
  | { kind: "nbt"; value: NbtTag }
  | { kind: "scores"; scores: Record<string, Range> }
  | { kind: "advancements"; advancements: Record<string, boolean | Record<string, boolean>> };

export interface EntitySelector {
  /** `@p` / `@a` / `@r` / `@s` / `@e` / `@n` の文字 */
  variable: string;
  arguments: SelectorArgument[];
}

export interface ItemComponent {
  /** `!` で消す指定 */
  removed: boolean;
  key: string;
  value?: NbtTag;
}

export interface ItemPredicateTest {
  key: string;
  negated: boolean;
  /** `=` は値の一致、`~` は述語、なしは存在 */
  op?: "=" | "~";
  value?: NbtTag;
}

export type NbtPathNode =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "all" }
  | { kind: "filter"; filter: NbtTag };

export type ArgumentValue =
  | { kind: "bool"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "long"; value: bigint }
  | { kind: "string"; value: string }
  | { kind: "selector"; selector: EntitySelector }
  /** プレイヤー名、UUID、スコアの保持者名、`*` */
  | { kind: "name"; value: string }
  | { kind: "coordinates"; coordinates: Coordinate[] }
  | { kind: "block"; id: string; tag: boolean; states: Record<string, string>; nbt?: NbtTag }
  | { kind: "item"; id: string; tag: boolean; components: ItemComponent[]; legacyTag?: NbtCompound }
  | { kind: "itemPredicate"; id: string; tag: boolean; alternatives: ItemPredicateTest[][]; legacyTag?: NbtCompound }
  | { kind: "nbt"; value: NbtTag }
  | { kind: "nbtPath"; path: NbtPathNode[] }
  | { kind: "text"; format: TextFormat; value: NbtTag }
  | { kind: "resource"; id: string; tag: boolean }
  | { kind: "particle"; id: string; options?: NbtTag }
  | { kind: "range"; range: Range }
  | { kind: "time"; ticks: number }
  /** 中身をこれ以上分けない引数（演算子、スロット名、色など） */
  | { kind: "word"; value: string };

export type ArgumentParser = (r: StringReader, properties: Record<string, unknown> | undefined, options: ArgumentOptions) => ArgumentValue;

// ---- 共通の部品 ----

const isIdChar = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_" || c === "-" || c === "." || c === "/" || c === ":";

/** `名前空間:パス` を読み、名前空間がなければ minecraft を補う */
export function readResourceLocation(r: StringReader): string {
  const start = r.cursor;
  const raw = r.readWhile(isIdChar);
  if (!raw) throw r.error("ID が必要", start);
  const parts = raw.split(":");
  // パスが空の ID（`storage ns:`）は Java で使える
  if (parts.length > 2 || (parts.length === 2 && parts[0]?.includes("/"))) {
    throw r.error(`不正な ID '${raw}'`, start);
  }
  // 大文字など、ID に使えない文字が続いていればエラー（Java も同じく読めない）
  if (r.canRead() && /[A-Z]/.test(r.peek())) throw r.error(`ID に使えない文字 '${r.peek()}'`);
  return parts.length === 2 ? raw : `minecraft:${raw}`;
}

function readTagOrId(r: StringReader): { id: string; tag: boolean } {
  const tag = r.peek() === "#";
  if (tag) r.skip();
  return { id: readResourceLocation(r), tag };
}

function readRange(r: StringReader, integer: boolean): Range {
  const start = r.cursor;
  const text = r.readWhile((c) => (c >= "0" && c <= "9") || c === "." || c === "-" || c === "+");
  // "1..2" の "1." を小数として読まないよう、".." の位置で分ける
  const dots = text.indexOf("..");
  const lo = dots >= 0 ? text.slice(0, dots) : text;
  const hi = dots >= 0 ? text.slice(dots + 2) : undefined;
  if (!lo && !hi) throw r.error(text ? `範囲ではない '${text}'` : "範囲が必要", start);
  const num = (s: string): number => {
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s) || (integer && !/^-?\d+$/.test(s))) throw r.error(`範囲の数値ではない '${s}'`, start);
    return Number(s);
  };
  const out: Range = {};
  if (lo) out.min = num(lo);
  if (dots < 0) out.max = out.min as number;
  else if (hi) out.max = num(hi);
  return out;
}

function readCoordinate(r: StringReader, integer: boolean): Coordinate {
  const c = r.peek();
  if (c === "~" || c === "^") {
    r.skip();
    const next = r.peek();
    const value = r.canRead() && next !== " " ? r.readDouble() : 0;
    return { kind: c === "~" ? "relative" : "local", value };
  }
  if (!r.canRead() || c === " ") throw r.error("座標が必要");
  return { kind: "absolute", value: integer ? r.readInt() : r.readDouble() };
}

function readCoordinates(r: StringReader, count: number, opts: { integer: boolean; local: boolean }): Coordinate[] {
  const out: Coordinate[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      if (r.peek() !== " ") throw r.error("座標が足りない");
      r.skip();
    }
    out.push(readCoordinate(r, opts.integer));
  }
  const locals = out.filter((c) => c.kind === "local").length;
  if (locals > 0 && (!opts.local || locals !== out.length)) throw r.error("^ と他の座標は混ぜられない");
  return out;
}

// ---- セレクタ ----

const SELECTOR_VARIABLES = new Set(["p", "a", "r", "s", "e", "n"]);

function readSelectorValue(r: StringReader, key: string): SelectorValue {
  switch (key) {
    case "distance":
    case "x_rotation":
    case "y_rotation":
      return { kind: "range", range: readRange(r, false) };
    case "level":
      return { kind: "range", range: readRange(r, true) };
    case "x":
    case "y":
    case "z":
    case "dx":
    case "dy":
    case "dz":
      return { kind: "number", value: r.readDouble() };
    case "limit": {
      const start = r.cursor;
      const value = r.readInt();
      if (value < 1) throw r.error("limit は1以上", start);
      return { kind: "number", value };
    }
    case "type":
    case "predicate": {
      const v = readTagOrId(r);
      return { kind: "resource", ...v };
    }
    case "nbt":
      return { kind: "nbt", value: readSnbtCompound(r) };
    case "scores": {
      r.expect("{");
      const scores = new Map<string, Range>();
      r.skipWhitespace();
      while (r.canRead() && r.peek() !== "}") {
        const name = r.readUnquotedString();
        r.skipWhitespace();
        r.expect("=");
        r.skipWhitespace();
        scores.set(name, readRange(r, true));
        r.skipWhitespace();
        if (r.peek() === ",") {
          r.skip();
          r.skipWhitespace();
        }
      }
      r.expect("}");
      return { kind: "scores", scores: Object.fromEntries(scores) };
    }
    case "advancements": {
      r.expect("{");
      const advancements: Record<string, boolean | Record<string, boolean>> = {};
      r.skipWhitespace();
      while (r.canRead() && r.peek() !== "}") {
        const id = readResourceLocation(r);
        r.skipWhitespace();
        r.expect("=");
        r.skipWhitespace();
        if (r.peek() === "{") {
          r.skip();
          const criteria: Record<string, boolean> = {};
          r.skipWhitespace();
          while (r.canRead() && r.peek() !== "}") {
            const c = r.readUnquotedString();
            r.skipWhitespace();
            r.expect("=");
            r.skipWhitespace();
            criteria[c] = r.readBoolean();
            r.skipWhitespace();
            if (r.peek() === ",") {
              r.skip();
              r.skipWhitespace();
            }
          }
          r.expect("}");
          advancements[id] = criteria;
        } else advancements[id] = r.readBoolean();
        r.skipWhitespace();
        if (r.peek() === ",") {
          r.skip();
          r.skipWhitespace();
        }
      }
      r.expect("}");
      return { kind: "advancements", advancements };
    }
    case "name":
      return { kind: "string", value: r.readString() };
    case "tag":
    case "team":
    case "gamemode":
    case "sort":
      return { kind: "string", value: r.readUnquotedString() };
    default:
      throw r.error(`未知のセレクタ引数 '${key}'`);
  }
}

const NEGATABLE = new Set(["name", "type", "tag", "team", "gamemode", "nbt", "predicate"]);

export function readSelector(r: StringReader): EntitySelector {
  const start = r.cursor;
  r.expect("@");
  const variable = r.read();
  if (!SELECTOR_VARIABLES.has(variable)) throw r.error(`不明なセレクタ '@${variable}'`, start);
  const args: SelectorArgument[] = [];
  if (r.peek() === "[") {
    r.skip();
    r.skipWhitespace();
    while (r.canRead() && r.peek() !== "]") {
      const keyStart = r.cursor;
      const key = r.readUnquotedString();
      if (!key) throw r.error("セレクタ引数の名前が必要", keyStart);
      r.skipWhitespace();
      r.expect("=");
      r.skipWhitespace();
      const negated = r.peek() === "!";
      if (negated) {
        if (!NEGATABLE.has(key)) throw r.error(`'${key}' は ! で否定できない`);
        r.skip();
        r.skipWhitespace();
      }
      args.push({ key, negated, value: readSelectorValue(r, key) });
      r.skipWhitespace();
      if (r.peek() === ",") {
        r.skip();
        r.skipWhitespace();
      } else if (r.peek() !== "]") throw r.error("',' か ']' が必要");
    }
    r.expect("]");
  }
  return { variable, arguments: args };
}

// ---- NBT パス ----

const isPathKeyChar = (c: string): boolean => c !== " " && c !== '"' && c !== "'" && c !== "[" && c !== "]" && c !== "." && c !== "{" && c !== "}";

function readQuotedKey(r: StringReader): string {
  // NBT パスのキーの引用符は SNBT の文字列と同じ書き方
  const tag = readSnbtValue(r);
  if (tag.type !== "string") throw r.error("キーが必要");
  return tag.value;
}

export function readNbtPath(r: StringReader): NbtPathNode[] {
  const path: NbtPathNode[] = [];
  let first = true;
  while (r.canRead() && r.peek() !== " ") {
    const c = r.peek();
    if (c === "{") {
      if (!first && path.at(-1)?.kind !== "key") throw r.error("フィルタの位置が不正");
      path.push({ kind: "filter", filter: readSnbtCompound(r) });
    } else if (c === "[") {
      r.skip();
      const p = r.peek();
      if (p === "]") path.push({ kind: "all" });
      else if (p === "{") path.push({ kind: "filter", filter: readSnbtCompound(r) });
      else path.push({ kind: "index", index: r.readInt() });
      r.expect("]");
    } else if (c === '"' || c === "'") {
      if (!first) throw r.error("'.' が必要");
      path.push({ kind: "key", key: readQuotedKey(r) });
    } else if (c === ".") {
      if (first) throw r.error("パスが '.' で始まっている");
      r.skip();
      const q = r.peek();
      // `Items.[0]` のように '.' の直後に '[' を書いても Java は読む（実測、#13）
      if (q === "[" || q === "{") continue;
      if (q === '"' || q === "'") path.push({ kind: "key", key: readQuotedKey(r) });
      else {
        const key = r.readWhile(isPathKeyChar);
        if (!key) throw r.error("キーが必要");
        path.push({ kind: "key", key });
      }
    } else {
      if (!first) throw r.error(`パスに続く文字が不正 '${c}'`);
      const key = r.readWhile(isPathKeyChar);
      if (!key) throw r.error(`パスが必要（'${c}'）`);
      path.push({ kind: "key", key });
    }
    first = false;
  }
  if (path.length === 0) throw r.error("NBT パスが必要");
  return path;
}

// ---- ブロックとアイテム ----

function readBlockStates(r: StringReader): Record<string, string> {
  const states: Record<string, string> = {};
  r.expect("[");
  r.skipWhitespace();
  while (r.canRead() && r.peek() !== "]") {
    const key = r.readString();
    r.skipWhitespace();
    r.expect("=");
    r.skipWhitespace();
    const value = r.readString();
    if (!key || !value) throw r.error("ブロックの状態が不正");
    states[key] = value;
    r.skipWhitespace();
    if (r.peek() === ",") {
      r.skip();
      r.skipWhitespace();
    } else if (r.peek() !== "]") throw r.error("',' か ']' が必要");
  }
  r.expect("]");
  return states;
}

function readBlock(r: StringReader, allowTag: boolean): ArgumentValue {
  const start = r.cursor;
  const { id, tag } = readTagOrId(r);
  if (tag && !allowTag) throw r.error("ここではタグは使えない", start);
  const states = r.peek() === "[" ? readBlockStates(r) : {};
  const value: ArgumentValue = { kind: "block", id, tag, states };
  if (r.peek() === "{") value.nbt = readSnbtCompound(r);
  return value;
}

const readItemStack: ArgumentParser = (r, _properties, options) => {
  const id = readResourceLocation(r);
  const components: ItemComponent[] = [];
  if (options.version === "1.20.4") {
    return { kind: "item", id, tag: false, components, ...(r.peek() === "{" ? { legacyTag: readSnbtCompound(r) } : {}) };
  }
  if (r.peek() === "[") {
    r.skip();
    r.skipWhitespace();
    while (r.canRead() && r.peek() !== "]") {
      const removed = r.peek() === "!";
      if (removed) r.skip();
      const key = readResourceLocation(r);
      r.skipWhitespace();
      if (removed) components.push({ removed, key });
      else {
        r.expect("=");
        r.skipWhitespace();
        components.push({ removed, key, value: readSnbtValue(r) });
      }
      r.skipWhitespace();
      if (r.peek() === ",") {
        r.skip();
        r.skipWhitespace();
      } else if (r.peek() !== "]") throw r.error("',' か ']' が必要");
    }
    r.expect("]");
  }
  return { kind: "item", id, tag: false, components };
};

const readItemPredicate: ArgumentParser = (r, _properties, options) => {
  if (options.version === "1.20.4") {
    return { kind: "itemPredicate", ...readTagOrId(r), alternatives: [], ...(r.peek() === "{" ? { legacyTag: readSnbtCompound(r) } : {}) };
  }
  let id = "*";
  let tag = false;
  if (r.peek() === "*") r.skip();
  else ({ id, tag } = readTagOrId(r));
  const alternatives: ItemPredicateTest[][] = [];
  if (r.peek() === "[") {
    r.skip();
    let group: ItemPredicateTest[] = [];
    r.skipWhitespace();
    while (r.canRead() && r.peek() !== "]") {
      const negated = r.peek() === "!";
      if (negated) r.skip();
      const key = readResourceLocation(r);
      r.skipWhitespace();
      const test: ItemPredicateTest = { key, negated };
      const op = r.peek();
      if (op === "=" || op === "~") {
        r.skip();
        r.skipWhitespace();
        test.op = op;
        test.value = readSnbtValue(r);
        r.skipWhitespace();
      }
      group.push(test);
      const sep = r.peek();
      if (sep === "," || sep === "|") {
        r.skip();
        r.skipWhitespace();
        if (sep === "|") {
          alternatives.push(group);
          group = [];
        }
      } else if (sep !== "]") throw r.error("',' か '|' か ']' が必要");
    }
    r.expect("]");
    alternatives.push(group);
  }
  return { kind: "itemPredicate", id, tag, alternatives };
};

// ---- 引数の型の一覧 ----

const word = (r: StringReader, allowed?: ReadonlySet<string>): ArgumentValue => {
  const start = r.cursor;
  const value = r.readUnquotedString();
  if (!value) throw r.error("語が必要", start);
  if (allowed && !allowed.has(value)) throw r.error(`不明な値 '${value}'`, start);
  return { kind: "word", value };
};

const checkBounds = (r: StringReader, start: number, n: number, properties: Record<string, unknown> | undefined): void => {
  const min = properties?.["min"];
  const max = properties?.["max"];
  if (typeof min === "number" && n < min) throw r.error(`${min} 以上が必要（${n}）`, start);
  if (typeof max === "number" && n > max) throw r.error(`${max} 以下が必要（${n}）`, start);
};

const entity: ArgumentParser = (r, properties) => {
  const start = r.cursor;
  if (r.peek() === "@") {
    const selector = readSelector(r);
    const single = properties?.["amount"] === "single";
    const players = properties?.["type"] === "players";
    const limit = selector.arguments.find((a) => a.key === "limit");
    if (single && (selector.variable === "a" || selector.variable === "e") && !(limit?.value.kind === "number" && limit.value.value <= 1)) {
      throw r.error("ここでは1体しか指定できない", start);
    }
    if (players && selector.variable === "e" && !selector.arguments.some((a) => a.key === "type" && !a.negated && a.value.kind === "resource" && a.value.id === "minecraft:player")) {
      throw r.error("ここではプレイヤーしか指定できない", start);
    }
    return { kind: "selector", selector };
  }
  // プレイヤー名か UUID
  const value = r.readString();
  if (!value) throw r.error("エンティティが必要", start);
  return { kind: "name", value };
};

const scoreHolder: ArgumentParser = (r) => {
  if (r.peek() === "@") return { kind: "selector", selector: readSelector(r) };
  const start = r.cursor;
  const value = r.readUntilSpace();
  if (!value) throw r.error("スコアの保持者が必要", start);
  return { kind: "name", value };
};

const resource: ArgumentParser = (r) => ({ kind: "resource", id: readResourceLocation(r), tag: false });
const resourceOrTag: ArgumentParser = (r) => ({ kind: "resource", ...readTagOrId(r) });
/** ID か、その場で書いた定義（SNBT）。ルートテーブル、述語、ダイアログなど */
const resourceOrInline: ArgumentParser = (r) => (r.peek() === "{" || r.peek() === "[" ? { kind: "nbt", value: readSnbtValue(r) } : resource(r, undefined, { textFormat: "snbt" }));

const OPERATIONS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<", ">", "><"]);
const ANCHORS = new Set(["eyes", "feet"]);
const GAMEMODES = new Set(["survival", "creative", "adventure", "spectator"]);
const HEIGHTMAPS = new Set(["world_surface", "motion_blocking", "motion_blocking_no_leaves", "ocean_floor"]);
const MIRRORS = new Set(["none", "front_back", "left_right"]);
const ROTATIONS = new Set(["none", "clockwise_90", "counterclockwise_90", "180"]);
const LEGACY_COLORS = new Set(["black", "dark_blue", "dark_green", "dark_aqua", "dark_red", "dark_purple", "gold", "gray", "dark_gray", "blue", "green", "aqua", "red", "light_purple", "yellow", "white", "reset"]);

/** JSON の値の終端を見つける。SNBT で先に読むと JSON 固有の \/ 等を拒否してしまう。 */
function readJsonText(r: StringReader): NbtTag {
  r.skipWhitespace();
  const start = r.cursor;
  let end = start;
  const first = r.peek();
  if (first === "{" || first === "[" || first === '"') {
    let depth = 0, quoted = false, escaped = false, complete = false;
    for (let i = start; i < r.input.length; i++) {
      const c = r.input[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') {
          quoted = false;
          if (depth === 0) { end = i + 1; complete = true; break; }
        }
      } else if (c === '"') quoted = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth === 0) { end = i + 1; complete = true; break; }
      }
    }
    if (!complete) throw r.error("JSON テキストが閉じていない", start);
  } else {
    while (end < r.input.length && !/\s/.test(r.input[end]!)) end++;
  }
  let normalized: string;
  try {
    const raw = r.input.slice(start, end);
    JSON.parse(raw);
    // 文字列だけを正規化し、1.0 等の元の数値表記・型を変えない。
    normalized = raw.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => JSON.stringify(JSON.parse(quoted)));
  }
  catch { throw r.error("JSON 形式のテキストが必要", start); }
  r.cursor = end;
  // JSON.stringify は \/ を通常の / に戻す。既存のテキスト用 NBT 表現へ正規化する。
  return readSnbtValue(new StringReader(normalized));
}

export const ARGUMENT_PARSERS: Record<string, ArgumentParser> = {
  "brigadier:bool": (r) => ({ kind: "bool", value: r.readBoolean() }),
  "brigadier:integer": (r, p) => {
    const start = r.cursor;
    const value = r.readInt();
    checkBounds(r, start, value, p);
    return { kind: "number", value };
  },
  "brigadier:long": (r, p) => {
    const start = r.cursor;
    const value = r.readLong();
    for (const key of ["min", "max"] as const) {
      const bound = p?.[key];
      if (bound === undefined) continue;
      // JSON.parse may already have rounded an unsafe integer; never use it silently.
      if (typeof bound !== "bigint" && !(typeof bound === "number" && Number.isSafeInteger(bound))) {
        throw r.error(`long の ${key} は正確な整数である必要がある`, start);
      }
      const exact = BigInt(bound);
      if ((key === "min" && value < exact) || (key === "max" && value > exact)) {
        throw r.error(`long の ${key} の範囲外（${value}）`, start);
      }
    }
    return { kind: "long", value };
  },
  "brigadier:float": (r, p) => {
    const start = r.cursor;
    const value = r.readDouble();
    checkBounds(r, start, value, p);
    return { kind: "number", value };
  },
  "brigadier:double": (r, p) => {
    const start = r.cursor;
    const value = r.readDouble();
    checkBounds(r, start, value, p);
    return { kind: "number", value };
  },
  "brigadier:string": (r, p) => {
    const type = p?.["type"];
    if (type === "greedy") {
      const value = r.remaining();
      r.cursor = r.input.length;
      return { kind: "string", value };
    }
    const start = r.cursor;
    const value = type === "phrase" ? r.readString() : r.readUnquotedString();
    if (!value && type !== "phrase") throw r.error("語が必要", start);
    return { kind: "string", value };
  },
  "minecraft:entity": entity,
  "minecraft:game_profile": (r, p) => {
    if (r.peek() !== "@") return scoreHolder(r, p, { textFormat: "snbt" });
    const start = r.cursor;
    const value = entity(r, p, { textFormat: "snbt" });
    if (value.kind === "selector" && ["e", "s", "n"].includes(value.selector.variable) &&
      !value.selector.arguments.some((a) => a.key === "type" && !a.negated && a.value.kind === "resource" && a.value.id === "minecraft:player")) {
      throw r.error("ここではプレイヤーしか指定できない", start);
    }
    return value;
  },
  "minecraft:score_holder": (r) => (r.peek() === "*" && (r.peek(1) === " " || !r.canRead(2)) ? (r.skip(), { kind: "name", value: "*" }) : scoreHolder(r, undefined, { textFormat: "snbt" })),
  "minecraft:block_pos": (r) => ({ kind: "coordinates", coordinates: readCoordinates(r, 3, { integer: true, local: true }) }),
  "minecraft:column_pos": (r) => ({ kind: "coordinates", coordinates: readCoordinates(r, 2, { integer: true, local: false }) }),
  "minecraft:vec3": (r) => ({ kind: "coordinates", coordinates: readCoordinates(r, 3, { integer: false, local: true }) }),
  "minecraft:vec2": (r) => ({ kind: "coordinates", coordinates: readCoordinates(r, 2, { integer: false, local: false }) }),
  "minecraft:rotation": (r) => ({ kind: "coordinates", coordinates: readCoordinates(r, 2, { integer: false, local: false }) }),
  "minecraft:angle": (r) => ({ kind: "coordinates", coordinates: readCoordinates(r, 1, { integer: false, local: false }) }),
  "minecraft:color": (r) => word(r, LEGACY_COLORS),
  "minecraft:block_state": (r) => readBlock(r, false),
  "minecraft:block_predicate": (r) => readBlock(r, true),
  "minecraft:item_stack": readItemStack,
  "minecraft:item_predicate": readItemPredicate,
  "minecraft:nbt_compound_tag": (r) => ({ kind: "nbt", value: readSnbtCompound(r) }),
  "minecraft:nbt_tag": (r) => ({ kind: "nbt", value: readSnbtValue(r) }),
  "minecraft:nbt_path": (r) => ({ kind: "nbtPath", path: readNbtPath(r) }),
  "minecraft:component": (r, _p, o) => {
    const value = o.textFormat === "json" ? readJsonText(r) : readSnbtValue(r);
    return { kind: "text", format: o.textFormat, value };
  },
  "minecraft:style": (r) => ({ kind: "nbt", value: readSnbtCompound(r) }),
  "minecraft:message": (r) => {
    const value = r.remaining();
    r.cursor = r.input.length;
    return { kind: "string", value };
  },
  "minecraft:resource_location": resource,
  "minecraft:resource": resource,
  "minecraft:resource_key": resource,
  "minecraft:resource_or_tag": resourceOrTag,
  "minecraft:resource_or_tag_key": resourceOrTag,
  "minecraft:resource_selector": (r) => {
    const start = r.cursor;
    const value = r.readWhile((c) => isIdChar(c) || c === "*" || c === "?");
    if (!value) throw r.error("ID が必要", start);
    return { kind: "word", value };
  },
  "minecraft:function": resourceOrTag,
  "minecraft:dimension": resource,
  "minecraft:feature": resource,
  "minecraft:loot_table": resourceOrInline,
  "minecraft:loot_predicate": resourceOrInline,
  "minecraft:loot_modifier": resourceOrInline,
  "minecraft:dialog": resourceOrInline,
  "minecraft:particle": (r) => {
    const id = readResourceLocation(r);
    const value: ArgumentValue = { kind: "particle", id };
    if (r.peek() === "{") value.options = readSnbtCompound(r);
    return value;
  },
  "minecraft:objective": (r) => word(r),
  "minecraft:team": (r) => word(r),
  "minecraft:objective_criteria": (r) => {
    const start = r.cursor;
    const value = r.readUntilSpace();
    if (!value) throw r.error("評価基準が必要", start);
    return { kind: "word", value };
  },
  "minecraft:operation": (r) => {
    const start = r.cursor;
    const value = r.readUntilSpace();
    if (!OPERATIONS.has(value)) throw r.error(`不明な演算子 '${value}'`, start);
    return { kind: "word", value };
  },
  "minecraft:int_range": (r) => ({ kind: "range", range: readRange(r, true) }),
  "minecraft:float_range": (r) => ({ kind: "range", range: readRange(r, false) }),
  "minecraft:time": (r, p) => {
    const start = r.cursor;
    const n = r.readDouble();
    const unit = r.peek();
    const scale = unit === "d" ? 24000 : unit === "s" ? 20 : 1;
    if (unit === "d" || unit === "s" || unit === "t") r.skip();
    // TimeArgument scales a Java float and rounds it to a signed int.
    const ticks = Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(Math.fround(Math.fround(n) * scale)))) || 0;
    checkBounds(r, start, ticks, p);
    return { kind: "time", ticks };
  },
  "minecraft:uuid": (r) => {
    const start = r.cursor;
    const value = r.readWhile((c) => /[0-9a-fA-F-]/.test(c));
    if (!uuidToInts(value)) throw r.error("UUID ではない", start);
    return { kind: "word", value };
  },
  "minecraft:swizzle": (r) => {
    const start = r.cursor;
    const value = r.readWhile((c) => c === "x" || c === "y" || c === "z");
    if (!value || new Set(value).size !== value.length) throw r.error("軸の指定が不正", start);
    return { kind: "word", value };
  },
  "minecraft:entity_anchor": (r) => word(r, ANCHORS),
  "minecraft:gamemode": (r) => word(r, GAMEMODES),
  "minecraft:heightmap": (r) => word(r, HEIGHTMAPS),
  "minecraft:template_mirror": (r) => word(r, MIRRORS),
  "minecraft:template_rotation": (r) => word(r, ROTATIONS),
  "minecraft:item_slot": (r) => word(r),
  "minecraft:item_slots": (r) => {
    const start = r.cursor;
    const value = r.readWhile((c) => /[a-z0-9_.*]/.test(c));
    if (!value) throw r.error("スロットが必要", start);
    return { kind: "word", value };
  },
  "minecraft:slot_source": (r) => {
    // `weapon.*` のような範囲の指定
    const start = r.cursor;
    const value = r.readWhile((c) => /[a-z0-9_.*]/.test(c));
    if (!value) throw r.error("スロットが必要", start);
    return { kind: "word", value };
  },
  "minecraft:scoreboard_slot": (r) => word(r),
  "minecraft:team_color": (r) => word(r, LEGACY_COLORS),
  "minecraft:swing_animation": (r) => word(r),
  "minecraft:hex_color": (r) => {
    const start = r.cursor;
    const value = r.readWhile((c) => /[0-9a-fA-F]/.test(c));
    if (value.length !== 6) throw r.error("6桁の16進の色が必要", start);
    return { kind: "word", value };
  },
  "minecraft:context_int_provider": (r) => ({ kind: "nbt", value: readSnbtValue(r) }),
  "minecraft:context_float_provider": (r) => ({ kind: "nbt", value: readSnbtValue(r) }),
};
