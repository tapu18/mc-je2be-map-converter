// Java のコマンドを BE のコマンドに書き換える（design.md 5.3・5.4、#62）。
// パースした節の位置を使って、元の文字列のうち変える必要のある部分だけを差し替える。
// 書き換えられるコマンドの形は COMMANDS と EXECUTE_STEPS に列挙したものだけで、それ以外は unsupported として返す
// （5.4 では、そのチェーンをランタイムで実行する。ランタイムは M2）。
//
// 確度：出力する BE の書き方は BDS 1.26.63.1 が構文として受理することを実測した（rewrite.servers.test.ts）。
// 意味が Java と一致することは、変換を通すシナリオ（scenarios/convert/）で確かめたものだけが実測で、残りは未確認。
import type { BlockDefaults } from "../java/world.ts";
import type { MappingLookup } from "../mappings/mappings.ts";
import type { ArgumentValue, EntitySelector, Range } from "./arguments.ts";
import { readSelector } from "./arguments.ts";
import { toCommandIR, type CommandParser, type ParsedNode } from "./parser.ts";
import { formatRawText, plainText, toRawText } from "./rawtext.ts";
import { CommandSyntaxError, StringReader } from "./reader.ts";

export interface RewriteContext {
  parser: CommandParser;
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

const SCOREBOARD_SLOTS: Record<string, string> = { list: "list", sidebar: "sidebar", belowName: "belowname", below_name: "belowname" };

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
      case "type":
        if (v.kind !== "resource") break;
        if (v.tag) return { ok: false, message: `エンティティの種類のタグ（type=#${v.id}）は BE にない` };
        if (JAVA_ONLY_ENTITIES.has(v.id)) return { ok: false, message: `${v.id} は BE にない（代替エンティティは未実装）` };
        // 種類の ID が BE と同じ名前かは種類ごとには確かめていない（未確認。ID 対応表はブロック・アイテムだけ）
        out.push(`type=${not}${v.id.replace(/^minecraft:/, "")}`);
        break;
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

/** 文字列のセレクタ（テキストの selector など）を読んで書き換える */
function rewriteSelectorString(s: string): SelectorRewrite {
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
  if (m.status === "inexact") return ed.unsupported(`ブロックの条件 ${v.id}${JSON.stringify(v.states)} を BE では同じ範囲に書けない`), undefined;
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
    case "text": {
      const r = toRawText(v.value, { selector: rewriteSelectorString });
      for (const i of r.issues) (i.severity === "unsupported" ? ed.unsupported(i.message) : ed.warn(i.message));
      ed.replace(n.start, n.end, formatRawText(r.rawtext));
      return;
    }
    case "time":
      ed.replace(n.start, n.end, String(v.ticks));
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

type CommandHandler = (nodes: ParsedNode[], head: ParsedNode, ctx: RewriteContext, ed: Editor) => void;

const ok: CommandHandler = () => {};

const COMMANDS: Record<string, CommandHandler> = {
  say: ok,
  tellraw: ok,
  kill: ok,
  tag: ok,
  title: (nodes, head, _ctx, ed) => {
    const sub = literals(nodes)[0];
    // テキストを出すものは BE では titleraw（times・clear・reset は title のまま）
    if (sub === "title" || sub === "subtitle" || sub === "actionbar") ed.replace(head.start, head.end, "titleraw");
  },
  teleport: (nodes, _head, _ctx, ed) => {
    const lits = literals(nodes);
    if (lits.includes("facing") && lits.includes("entity")) ed.unsupported("tp の facing entity の書き換えは未実装");
  },
  setblock: (nodes, _head, _ctx, ed) => {
    if (literals(nodes).includes("strict")) ed.unsupported("setblock の strict は BE にない");
  },
  fill: (nodes, _head, _ctx, ed) => {
    const lits = literals(nodes);
    if (lits.includes("strict")) ed.unsupported("fill の strict は BE にない");
    // BE の fill の replace の後ろには、置き方（destroy など）を書けない
    if (lits[0] === "replace" && lits.length > 1) ed.unsupported(`fill の replace と ${lits[1]} の組み合わせは BE にない`);
  },
  clone: (nodes, _head, _ctx, ed) => {
    const lits = literals(nodes);
    if (lits.includes("from") || lits.includes("to")) ed.unsupported("clone のディメンション指定は BE にない");
    if (lits.includes("strict")) ed.unsupported("clone の strict は BE にない");
    // BE の filtered は引数の順が違う（filtered <mode> <block>）。並べ替えは未実装
    if (lits.includes("filtered")) ed.unsupported("clone の filtered の書き換えは未実装");
  },
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
      ed.unsupported(`execute ${kind} は BE にない（ランタイムで実行する。未実装）`);
  }
}

/** コマンド1つを BE のコマンドに書き換える */
export function rewriteCommand(source: string, ctx: RewriteContext): RewriteResult {
  const parsed = ctx.parser.parse(source);
  if (!parsed.ok) return { status: "invalid", message: parsed.error.message, position: parsed.error.position };
  const ed = new Editor(source);
  const ir = toCommandIR(source, parsed.nodes);
  for (const step of ir.context) checkExecuteStep(step.kind, step.nodes, ed);
  if (ir.command) {
    const handler = COMMANDS[ir.command.name];
    if (!handler) ed.unsupported(`${ir.command.name} の書き換えは未対応`);
    else {
      // 最後のコマンドの名前の節：run の先なら最後の jump=root、execute でなければ先頭
      const head = [...parsed.nodes].reverse().find((n) => n.jump === "root") ?? parsed.nodes[0]!;
      if (!ed.failed) handler(ir.command.nodes, head, ctx, ed);
    }
  }
  if (ed.failed) return { status: "unsupported", issues: ed.issues };
  for (const n of parsed.nodes) rewriteNode(n, ctx, ed);
  if (ed.failed) return { status: "unsupported", issues: ed.issues };
  let command = ed.result();
  if (command.startsWith("/")) command = command.slice(1);
  return { status: ed.changed ? "rewritten" : "unchanged", command, issues: ed.issues };
}
