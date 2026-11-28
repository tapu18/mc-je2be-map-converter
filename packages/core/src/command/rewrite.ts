// Java のコマンドを BE のコマンドに書き換える（design.md 5.3・5.4、#62）。
// パースした節の位置を使って、元の文字列のうち変える必要のある部分だけを差し替える。
// 書き換えられるコマンドの形は COMMANDS と EXECUTE_STEPS に列挙したものだけで、それ以外は unsupported として返す
// （5.4 では、そのチェーンをランタイムで実行する。ランタイムは M2）。
//
// 確度：出力する BE の書き方は BDS 1.26.63.1 が構文として受理することを実測した（rewrite.servers.test.ts）。
// 意味が Java と一致することは、変換を通すシナリオ（scenarios/convert/）で確かめたものだけが実測で、残りは未確認。
import { rewriteEffect } from "../features/effect/rewrite.ts";
import { rewriteKill, rewriteTag, rewriteTeleport } from "../features/entity/rewrite.ts";
import { rewriteGameRule } from "../features/game_rule/rewrite.ts";
import { rewriteSound } from "../features/sound/rewrite.ts";
import type { BlockDefaults } from "../java/world.ts";
import type { MappingLookup } from "../mappings/mappings.ts";
import type { ArgumentValue, EntitySelector, Range } from "./arguments.ts";
import { readSelector } from "./arguments.ts";
import { bedrockEntityType } from "./bedrock-command-ids.ts";
import { isEarlierJavaRelease, normalizeCommandIR } from "./normalize-command.ts";
import { toCommandIR, type CommandIR, type CommandParser, type ParsedNode } from "./parser.ts";
import { plainText, toRawText } from "../features/text/rawtext.ts";
import { rewriteTextNode, rewriteTitleHead } from "../features/text/rewrite.ts";
import { CommandSyntaxError, StringReader } from "./reader.ts";

export interface RewriteContext {
  parser: CommandParser;
  /** parser に設定した Java の版を上書きする。版があれば書き換えの前に IR を正規化する。 */
  sourceVersion?: string;
  mappings: MappingLookup;
  /** Java のブロックの既定の状態（データ生成の blocks.json）。`setblock ... oak_stairs[facing=east]` の省いた状態を補う */
  blockDefaults: BlockDefaults;
}

export interface RewriteIssue {
  /** unsupported：BE のコマンド1個にできない。warning：書き換えたが、意味や見た目が変わり得る */
  severity: "unsupported" | "warning";
  message: string;
}

export type RewriteResult =
  /** BE のコマンド。unchanged は元の文字列のまま（先頭の / を除く） */
  | { status: "rewritten" | "unchanged"; command: string; issues: RewriteIssue[] }
  | { status: "unsupported"; issues: RewriteIssue[] }
  /** Java の文法で読めない（Java でも動かない） */
  | { status: "invalid"; message: string; position: number };

/** Java だけにあるエンティティ（BE に同じ種類がない）。代替エンティティは design.md 5.8 */
const JAVA_ONLY_ENTITIES = new Set(["marker", "interaction", "text_display", "block_display", "item_display"].map((s) => `minecraft:${s}`));

const DIMENSIONS: Record<string, string> = {
  "minecraft:overworld": "overworld",
  "minecraft:the_nether": "nether",
  "minecraft:the_end": "the_end",
};

/** Java 26.3 の表示場所の名前は below_name（belowName は拒否される。rewrite.servers.test.ts で実測） */
const SCOREBOARD_SLOTS: Record<string, string> = { list: "list", sidebar: "sidebar", belowName: "belowname", below_name: "belowname" };
const DAY_MARKERS = new Map([["day", 1000], ["noon", 6000], ["night", 13000], ["midnight", 18000]]);

// ---- セレクタ ----

const num = (n: number): string => String(n);

function formatRange(r: Range): string {
  if (r.min !== undefined && r.min === r.max) return num(r.min);
  return `${r.min !== undefined ? num(r.min) : ""}..${r.max !== undefined ? num(r.max) : ""}`;
}

const quoteIfNeeded = (s: string): string => (/^[A-Za-z0-9_.+-]+$/.test(s) ? s : JSON.stringify(s));

export type SelectorRewrite = { ok: true; value: string; warnings: string[] } | { ok: false; message: string };

/** Java のセレクタを BE の書き方にする */
export function rewriteSelector(sel: EntitySelector): SelectorRewrite {
  const out: string[] = [];
  const warnings: string[] = [];
  let variable = sel.variable;
  let limit: number | undefined;
  let sort: string | undefined;
  if (variable === "n") {
    // @n は @e[limit=1,sort=nearest]
    variable = "e";
    limit = 1;
    sort = "nearest";
  }
  for (const a of sel.arguments) {
    const v = a.value;
    const not = a.negated ? "!" : "";
    switch (a.key) {
      case "distance":
        if (v.kind !== "range") break;
        if (v.range.min !== undefined) out.push(`rm=${num(v.range.min)}`);
        if (v.range.max !== undefined) out.push(`r=${num(v.range.max)}`);
        break;
      case "x": case "y": case "z": case "dx": case "dy": case "dz":
        if (v.kind === "number") out.push(`${a.key}=${num(v.value)}`);
        break;
      case "limit":
        if (v.kind === "number") limit = v.value;
        break;
      case "sort":
        if (v.kind === "string") sort = v.value;
        break;
      case "type": {
        if (v.kind !== "resource") break;
        if (v.tag) return { ok: false, message: `エンティティの種類のタグ（type=#${v.id}）は BE にない` };
        if (JAVA_ONLY_ENTITIES.has(v.id)) return { ok: false, message: `${v.id} は BE にない（代替エンティティは未実装）` };
        const be = bedrockEntityType(v.id);
        if (!be) return { ok: false, message: `BE に対応のないエンティティの種類 ${v.id}` };
        out.push(`type=${not}${be}`);
        break;
      }
      case "tag":
        if (v.kind === "string") out.push(`tag=${not}${v.value}`);
        break;
      case "name":
        if (v.kind === "string") out.push(`name=${not}${quoteIfNeeded(v.value)}`);
        break;
      case "scores":
        if (v.kind === "scores") out.push(`scores={${Object.entries(v.scores).map(([k, r]) => `${k}=${formatRange(r)}`).join(",")}}`);
        break;
      case "level":
        if (v.kind !== "range") break;
        if (v.range.min !== undefined) out.push(`lm=${num(v.range.min)}`);
        if (v.range.max !== undefined) out.push(`l=${num(v.range.max)}`);
        break;
      case "gamemode":
        if (v.kind === "string") out.push(`m=${not}${v.value}`);
        break;
      case "x_rotation":
      case "y_rotation": {
        if (v.kind !== "range") break;
        const k = a.key === "x_rotation" ? "rx" : "ry";
        if (v.range.min !== undefined) out.push(`${k}m=${num(v.range.min)}`);
        if (v.range.max !== undefined) out.push(`${k}=${num(v.range.max)}`);
        break;
      }
      case "team":
        return { ok: false, message: "BE にチームはない（team=）" };
      case "nbt":
      case "predicate":
      case "advancements":
        return { ok: false, message: `${a.key}= はランタイムで評価する（未実装）` };
      default:
        return { ok: false, message: `未対応のセレクタ引数 '${a.key}'` };
    }
  }
  // 並べ方と数：BE の c は近い順（負なら遠い順）で選ぶ
  if (limit !== undefined) {
    if (sort === "furthest") out.push(`c=${-limit}`);
    else if (sort === "random") {
      if (variable !== "r") return { ok: false, message: "sort=random は @r でしか BE に書けない" };
      out.push(`c=${limit}`);
    } else {
      if (sort === undefined || sort === "arbitrary") {
        if (variable === "e" || variable === "a") warnings.push(`limit=${limit} の選び方が変わる（Java は読み込み順、BE は近い順）`);
      }
      out.push(`c=${limit}`);
    }
  } else if (sort !== undefined && sort !== "arbitrary") {
    warnings.push(`limit のない sort=${sort} を落とした（実行順が変わり得る）`);
  }
  return { ok: true, value: out.length ? `@${variable}[${out.join(",")}]` : `@${variable}`, warnings };
}
/** 文字列のセレクタ（テキストの selector など）を読んで書き換える。集計（tools/text-components.ts）でも使う */
export function rewriteSelectorString(s: string): SelectorRewrite {
  try {
    const r = new StringReader(s);
    const sel = readSelector(r);
    if (r.canRead()) return { ok: false, message: `セレクタの後ろに余分な文字 '${r.remaining()}'` };
    return rewriteSelector(sel);
  } catch (e) {
    if (e instanceof CommandSyntaxError) return { ok: false, message: `セレクタとして読めない: ${e.message}` };
    throw e;
  }
}

// ---- 書き換えの組み立て ----

class Editor {
  readonly source: string;
  private readonly edits: { start: number; end: number; text: string }[] = [];
  readonly issues: RewriteIssue[] = [];

  constructor(source: string) {
    this.source = source;
  }

  replace(start: number, end: number, text: string): void {
    if (this.source.slice(start, end) === text) return;
    this.edits.push({ start, end, text });
  }

  /** その範囲がすでに書き換えられているか（コマンドごとの処理が共通の処理より先に書き換えたもの） */
  touched(start: number, end: number): boolean {
    return this.edits.some((e) => e.start < end && start < e.end);
  }

  unsupported(message: string): void {
    this.issues.push({ severity: "unsupported", message });
  }

  warn(message: string): void {
    if (!this.issues.some((i) => i.message === message)) this.issues.push({ severity: "warning", message });
  }

  get failed(): boolean {
    return this.issues.some((i) => i.severity === "unsupported");
  }

  get changed(): boolean {
    return this.edits.length > 0;
  }

  result(): string {
    let out = "";
    let at = 0;
    for (const e of [...this.edits].sort((a, b) => a.start - b.start)) {
      if (e.start < at) throw new Error(`書き換えの範囲が重なった: ${this.source}`);
      out += this.source.slice(at, e.start) + e.text;
      at = e.end;
    }
    return out + this.source.slice(at);
  }
}

type Value<K extends ArgumentValue["kind"]> = Extract<ArgumentValue, { kind: K }>;

const beStates = (states: Record<string, string | number | boolean>): string => {
  const entries = Object.entries(states);
  return entries.length ? ` [${entries.map(([k, v]) => `${JSON.stringify(k)}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`).join(",")}]` : "";
};

function rewriteBlockState(v: Value<"block">, ctx: RewriteContext, ed: Editor): string | undefined {
  if (v.nbt) return ed.unsupported(`ブロックの NBT（${v.id}{...}）はランタイムで扱う（未実装）`), undefined;
  const props = ctx.mappings.blockProperties(v.id);
  if (!props) return ed.unsupported(`BE に対応のないブロック ${v.id}`), undefined;
  const states = { ...(ctx.blockDefaults(v.id) ?? {}), ...v.states };
  const m = ctx.mappings.block(v.id, states);
  if (m.status !== "mapped") return ed.unsupported(`ブロックの状態を BE に対応させられない（${v.id}、${m.status}）`), undefined;
  if (m.waterlogged) ed.warn(`水没（${v.id}[waterlogged=true]）は BE では別の層で、この書き換えでは水が入らない`);
  return m.target.id + beStates(m.target.states);
}

function rewriteBlockPredicate(v: Value<"block">, ctx: RewriteContext, ed: Editor): string | undefined {
  if (v.tag) return ed.unsupported(`ブロックタグ #${v.id} の展開は未実装`), undefined;
  if (v.nbt) return ed.unsupported(`ブロックの NBT の条件（${v.id}{...}）はランタイムで評価する（未実装）`), undefined;
  const m = ctx.mappings.blockPredicate(v.id, v.states);
  if (m.status === "inexact") {
    const reason = {
      "multiple-ids": "対応先が複数の BE ブロック ID にまたがる",
      overlap: "共通する BE プロパティでは別の状態にも一致する",
      "collapsed-states": "条件に一致する状態と一致しない状態が同じ BE 主層の状態になる",
      waterlogged: "BE 主層の状態では水没の有無を区別できない",
    }[m.reason];
    return ed.unsupported(`ブロックの条件 ${v.id}${JSON.stringify(v.states)} を BE では同じ範囲に書けない（${reason}）`), undefined;
  }
  if (m.status !== "mapped") return ed.unsupported(`ブロックの条件を BE に対応させられない（${v.id}、${m.status}）`), undefined;
  return m.target.id + beStates(m.target.states);
}

/** 文中のセレクタ（`say` の @e[...] など）を書き換える */
function rewriteMessage(message: string, ed: Editor): string {
  let out = "";
  let i = 0;
  while (i < message.length) {
    const at = message.indexOf("@", i);
    if (at < 0) break;
    // @ の次がセレクタの文字で、その次が語の続きでないものだけをセレクタとみなす
    if (!/[parsen]/.test(message[at + 1] ?? "") || /[A-Za-z0-9_]/.test(message[at + 2] ?? " ")) {
      out += message.slice(i, at + 1);
      i = at + 1;
      continue;
    }
    out += message.slice(i, at);
    const r = new StringReader(message, at);
    let sel: EntitySelector;
    try {
      sel = readSelector(r);
    } catch (e) {
      if (!(e instanceof CommandSyntaxError)) throw e;
      out += "@";
      i = at + 1;
      continue;
    }
    const w = rewriteSelector(sel);
    if (!w.ok) {
      ed.unsupported(`文中のセレクタ: ${w.message}`);
      out += message.slice(at, r.cursor);
    } else {
      w.warnings.forEach((m) => ed.warn(m));
      out += w.value;
    }
    i = r.cursor;
  }
  return out + message.slice(i);
}

/** 節ごとの共通の書き換え（セレクタ、ブロック、テキスト、ディメンション、時間） */
function rewriteNode(n: ParsedNode, ctx: RewriteContext, ed: Editor): void {
  const v = n.value;
  if (!v || ed.touched(n.start, n.end)) return;
  switch (v.kind) {
    case "selector": {
      const r = rewriteSelector(v.selector);
      if (!r.ok) return ed.unsupported(r.message);
      r.warnings.forEach((m) => ed.warn(m));
      ed.replace(n.start, n.end, r.value);
      return;
    }
    case "block": {
      const text = n.parser === "minecraft:block_predicate" ? rewriteBlockPredicate(v, ctx, ed) : rewriteBlockState(v, ctx, ed);
      if (text !== undefined) ed.replace(n.start, n.end, text);
      return;
    }
    case "text":
      return rewriteTextNode(n, v.value, { selector: rewriteSelectorString }, ed);
    case "time":
      ed.replace(n.start, n.end, String(v.ticks));
      return;
    case "name":
      // BE は `#a`（execute if score の中）や `$b`（どこでも）を引用符なしでは読めない。引用符で囲めば読める（BDS 1.26.63.1 で実測）
      if (n.parser === "minecraft:score_holder" && v.value !== "*") ed.replace(n.start, n.end, quoteIfNeeded(v.value));
      return;
    case "string":
      if (n.parser === "minecraft:message") ed.replace(n.start, n.end, rewriteMessage(v.value, ed));
      return;
    case "resource":
      if (n.parser === "minecraft:dimension") {
        const d = DIMENSIONS[v.id];
        if (!d) return ed.unsupported(`BE にないディメンション ${v.id}`);
        ed.replace(n.start, n.end, d);
      }
      return;
    case "item":
      // give が自分で書き換える。ほかの場所のアイテムは各コマンドで未対応にしている
      return;
    default:
      return;
  }
}

const literals = (nodes: ParsedNode[]): string[] => nodes.filter((n) => n.kind === "literal").map((n) => n.name);
const arg = (nodes: ParsedNode[], name: string): ParsedNode | undefined => nodes.find((n) => n.kind === "argument" && n.name === name);

type CommandHandler = (nodes: ParsedNode[], head: ParsedNode, ctx: RewriteContext, ed: Editor, ir: import("./parser.ts").CommandIR) => void;

const ok: CommandHandler = () => {};

const COMMANDS: Record<string, CommandHandler> = {
  say: ok,
  tellraw: ok,
  kill: (nodes, _head, _ctx, ed) => rewriteKill(nodes, ed),
  tag: (nodes, _head, _ctx, ed) => rewriteTag(nodes, ed),
  title: (nodes, head, _ctx, ed) => rewriteTitleHead(literals(nodes)[0], head, ed),
  teleport: (nodes, _head, _ctx, ed) => rewriteTeleport(nodes, ed),
  setblock: (nodes, _head, _ctx, ed) => {
    if (literals(nodes).includes("strict")) ed.unsupported("setblock の strict は BE にない");
  },
  fill: (nodes, _head, _ctx, ed) => {
    const lits = literals(nodes);
    if (lits.includes("strict")) ed.unsupported("fill の strict は BE にない");
    // BE の fill の replace の後ろには、置き方（destroy など）を書けない
    if (lits[0] === "replace" && lits.length > 1) ed.unsupported(`fill の replace と ${lits[1]} の組み合わせは BE にない`);
  },
  clone: (nodes, _head, ctx, ed) => {
    const lits = literals(nodes);
    if (lits.includes("from") || lits.includes("to")) return ed.unsupported("clone のディメンション指定は BE にない");
    if (lits.includes("strict")) return ed.unsupported("clone の strict は BE にない");
    const filter = arg(nodes, "filter");
    if (filter?.value?.kind !== "block") return;
    const block = rewriteBlockPredicate(filter.value, ctx, ed);
    if (block === undefined) return;
    const mode = nodes[nodes.indexOf(filter) + 1];
    ed.replace(filter.start, mode?.end ?? filter.end, `${mode?.name ?? "normal"} ${block}`);
  },
  playsound: (_nodes, _head, ctx, ed, ir) => {
    rewriteSound(ir, (id) => ctx.mappings.sound(id), ed);
  },
  particle: (nodes, _head, ctx, ed) => {
    const name = arg(nodes, "name");
    if (name?.value?.kind !== "particle") return;
    const id = ctx.mappings.particle(name.value.id);
    if (!id) ed.unsupported(`BE に対応のないパーティクル ${name.value.id}`);
    const pos = arg(nodes, "pos");
    const delta = arg(nodes, "delta")?.value;
    const speed = arg(nodes, "speed")?.value;
    const count = arg(nodes, "count")?.value;
    const unsupported = [
      name.value.options && "粒子のオプション（色や種類など）",
      delta?.kind === "coordinates" && delta.coordinates.some((c) => c.kind !== "absolute" || c.value !== 0) && "拡散・方向（delta）",
      speed?.kind === "number" && speed.value !== 0 && "速度（speed）",
      count?.kind === "number" && count.value > 1 && `個数（count=${count.value}）`,
      literals(nodes).includes("force") && "表示範囲（force）",
      arg(nodes, "viewers") && "表示対象（viewers）",
    ].filter(Boolean);
    if (unsupported.length) ed.unsupported(`BE の particle で指定できない引数：${unsupported.join("、")}`);
    if (!id || unsupported.length) return;
    const position = pos ? ed.source.slice(pos.start, pos.end) : "~ ~ ~";
    ed.replace(name.start, nodes.at(-1)!.end, `${id} ${position}`);
    ed.warn("BE のパーティクルはエミッターを使うため、粒子の数や見た目が変わり得る");
  },
  effect: (nodes, head, _ctx, ed) => rewriteEffect(nodes, head, ed),
  gamemode: ok,
  time: (nodes, _head, ctx, ed) => {
    const [sub, option] = literals(nodes);
    if (sub === "add" || (sub === "query" && ["time", "gametime", "day", "daytime"].includes(option ?? ""))) return;
    if (sub === "set") {
      if (arg(nodes, "time")) return;
      const timemarker = arg(nodes, "timemarker");
      const marker = timemarker?.value;
      // 旧 Java の day などは絶対時刻。BE のマーカーは次に来る該当時刻へ進める。
      if (timemarker && marker?.kind === "resource" && marker.id.startsWith("minecraft:")) {
        const ticks = DAY_MARKERS.get(marker.id.slice("minecraft:".length));
        if (ticks !== undefined) {
          const version = ctx.sourceVersion ?? ctx.parser.options.version;
          if (version && isEarlierJavaRelease(version, "26.1")) ed.replace(timemarker.start, timemarker.end, String(ticks));
          return;
        }
      }
      const legacyTicks = DAY_MARKERS.get(option ?? "");
      if (legacyTicks !== undefined) {
        const literal = nodes[1]!;
        return ed.replace(literal.start, literal.end, String(legacyTicks));
      }
    }
    ed.unsupported("BE に直接対応する時刻の操作がない");
  },
  weather: (nodes, _head, _ctx, ed) => {
    const duration = arg(nodes, "duration");
    if (duration?.value?.kind !== "time") {
      return ed.warn("weather の継続時間の既定値は BE に従う");
    }
    ed.replace(duration.start, duration.end, String(duration.value.ticks));
  },
  difficulty: (nodes, _head, _ctx, ed) => {
    if (!nodes.length) ed.unsupported("BE の difficulty は難易度を指定する必要がある");
  },
  gamerule: (nodes, _head, _ctx, ed) => rewriteGameRule(nodes, ed),
  scoreboard: (nodes, _head, _ctx, ed) => {
    const [group, sub] = literals(nodes);
    if (group === "objectives") {
      if (sub === "add") {
        const criteria = arg(nodes, "criteria");
        if (criteria?.value?.kind === "word" && criteria.value.value !== "dummy") {
          ed.unsupported(`評価基準 ${criteria.value.value} は BE にない（dummy だけ）`);
        }
        const display = arg(nodes, "displayName");
        if (display?.value?.kind === "text") {
          const r = toRawText(display.value.value, { selector: rewriteSelectorString });
          const plain = r.issues.some((i) => i.severity === "unsupported") ? undefined : plainText(r.rawtext);
          // 表示名の書き換えは共通の処理（rawtext）を上書きする
          if (plain !== undefined) ed.replace(display.start, display.end, JSON.stringify(plain));
          else {
            ed.warn("書式つきの表示名は BE に書けないため落とした");
            const prev = criteria ?? display;
            ed.replace(prev === display ? display.start : prev.end, display.end, "");
          }
        }
      } else if (sub === "setdisplay") {
        const slot = arg(nodes, "slot");
        const name = slot?.value?.kind === "word" ? slot.value.value : "";
        const be = SCOREBOARD_SLOTS[name];
        if (!be) ed.unsupported(`表示場所 ${name} は BE にない`);
        else if (slot) ed.replace(slot.start, slot.end, be);
      } else if (sub !== "remove" && sub !== "list") ed.unsupported(`scoreboard objectives ${sub} は BE にない`);
    } else if (group === "players") {
      if (sub === "operation") {
        const op = arg(nodes, "operation");
        if (op?.value?.kind === "word" && (op.value.value === "/=" || op.value.value === "%=")) {
          ed.warn(`${op.value.value} は負の数で Java と結果が違う（docs/findings.md）`);
        }
      } else if (!["set", "add", "remove", "reset", "list"].includes(sub ?? "")) ed.unsupported(`scoreboard players ${sub} は BE にない`);
    }
  },
  give: (nodes, _head, ctx, ed) => {
    const item = arg(nodes, "item");
    const count = arg(nodes, "count");
    if (item?.value?.kind !== "item") return;
    if (item.value.components.length) return ed.unsupported(`アイテムのコンポーネント（${item.value.id}[...]）の書き換えは未実装`);
    const m = ctx.mappings.item(item.value.id);
    if (m.status !== "mapped") return ed.unsupported(`BE に対応のないアイテム ${item.value.id}`);
    const n = count?.value?.kind === "number" ? count.value.value : 1;
    const data = m.target.data ?? 0;
    // BE は give <対象> <アイテム> [数] [データ値]。ID が同じでデータ値がなければ元のまま
    if (m.target.bedrockId === item.value.id && !data) return;
    ed.replace(item.start, count?.end ?? item.end, `${m.target.bedrockId}${data || count ? ` ${n}` : ""}${data ? ` ${data}` : ""}`);
  },
};
COMMANDS["tp"] = COMMANDS["teleport"]!;

/** execute のサブコマンドのうち、BE にもあるもの */
function checkExecuteStep(kind: string, nodes: ParsedNode[], ed: Editor): void {
  const first = nodes[0];
  switch (kind) {
    case "as": case "at": case "rotated": case "facing": case "anchored": case "align": case "in":
      return;
    case "positioned":
      if (first?.kind === "literal" && first.name === "over") ed.unsupported("execute positioned over は BE にない");
      return;
    case "if":
    case "unless": {
      const what = first?.name ?? "";
      if (!["score", "entity", "block", "blocks"].includes(what)) ed.unsupported(`execute ${kind} ${what} は BE にない（ランタイムで評価する。未実装）`);
      return;
    }
    default:
      ed.unsupported(`execute ${kind} は BE コマンドに変換できない`);
  }
}

/** コマンド1つを BE のコマンドに書き換える */
export function rewriteCommand(source: string, ctx: RewriteContext): RewriteResult {
  return rewrite(source, ctx, false);
}

/** Rewrite just the terminal command. The runtime evaluates the Java execute/return frames itself. */
export function rewriteNativeCommand(source: string, ctx: RewriteContext): RewriteResult {
  return rewrite(source, ctx, true);
}

function rewrite(source: string, ctx: RewriteContext, terminalOnly: boolean): RewriteResult {
  const parsed = ctx.parser.parse(source);
  if (!parsed.ok) return { status: "invalid", message: parsed.error.message, position: parsed.error.position };
  let ir = toCommandIR(source, parsed.nodes);
  const sourceVersion = ctx.sourceVersion ?? ctx.parser.options.version;
  if (sourceVersion) {
    const normalized = normalizeCommandIR(ir, sourceVersion);
    if (!normalized.ok) {
      const { reason, start, end } = normalized;
      return { status: "unsupported", issues: [{ severity: "unsupported", message: `${reason}（${start}–${end}文字目）` }] };
    }
    ir = normalized.ir;
  }
  const head = [...parsed.nodes].reverse().find(node => node.jump === "root") ?? parsed.nodes[0]!;
  if (terminalOnly) {
    while (ir.command?.name === "return" && ir.command.run) ir = ir.command.run;
    if (!ir.command) {
      return {status: "unsupported", issues: [{severity: "unsupported", message: "委譲する末尾命令がない"}]};
    }
    ir = {source, context: [], command: ir.command};
  }
  return rewriteIR(ir, head, ctx, terminalOnly ? head.start : 0);
}

function rewriteIR(ir: CommandIR, head: ParsedNode, ctx: RewriteContext, start: number): RewriteResult {
  const ed = new Editor(ir.source);
  for (const step of ir.context) checkExecuteStep(step.kind, step.nodes, ed);
  if (ir.command) {
    const handler = Object.hasOwn(COMMANDS, ir.command.name) ? COMMANDS[ir.command.name] : undefined;
    if (!handler) ed.unsupported(`${ir.command.name} の書き換えは未対応`);
    else {
      if (!ed.failed) handler(ir.command.nodes, head, ctx, ed, ir);
    }
  }
  if (ed.failed) return { status: "unsupported", issues: ed.issues };
  for (const step of ir.context) for (const node of step.nodes) rewriteNode(node, ctx, ed);
  for (const node of ir.command?.nodes ?? []) rewriteNode(node, ctx, ed);
  if (ed.failed) return { status: "unsupported", issues: ed.issues };
  let command = ed.result().slice(start);
  if (command.startsWith("/")) command = command.slice(1);
  return { status: ed.changed ? "rewritten" : "unchanged", command, issues: ed.issues };
}
