// Java のテキスト（JSON / SNBT の text component）を BE の rawtext に変える（design.md 5.3、#62）。
// 書式は BE の § コードで表す。クリック・ホバーは BE にないため落とし、警告にする（UI の再設計は 5.9）。
// BE が rawtext を受理することは BDS 1.26.63.1 で実測した（rewrite.servers.test.ts）。見た目の一致は未確認（実クライアントで確かめる）。
import type { NbtTag } from "../nbt/nbt.ts";

export interface RawTextPart {
  text?: string;
  translate?: string;
  with?: { rawtext: RawTextPart[] };
  score?: { name: string; objective: string };
  selector?: string;
}

export interface RawText {
  rawtext: RawTextPart[];
}

export interface TextIssue {
  severity: "unsupported" | "warning";
  message: string;
}

export interface RawTextOptions {
  /** テキスト中のセレクタ（`selector` の値）を BE の書き方に変える。変えられなければ undefined と理由 */
  selector: (selector: string) => { ok: true; value: string } | { ok: false; message: string };
}

/** 色の名前 → § コード */
const COLORS: Record<string, string> = {
  black: "0", dark_blue: "1", dark_green: "2", dark_aqua: "3", dark_red: "4", dark_purple: "5", gold: "6", gray: "7",
  dark_gray: "8", blue: "9", green: "a", aqua: "b", red: "c", light_purple: "d", yellow: "e", white: "f",
};
/** 16色の RGB（Java の書式コードの色。16進の色を近い色に寄せるため） */
const PALETTE: [string, number][] = [
  ["0", 0x000000], ["1", 0x0000aa], ["2", 0x00aa00], ["3", 0x00aaaa], ["4", 0xaa0000], ["5", 0xaa00aa], ["6", 0xffaa00], ["7", 0xaaaaaa],
  ["8", 0x555555], ["9", 0x5555ff], ["a", 0x55ff55], ["b", 0x55ffff], ["c", 0xff5555], ["d", 0xff55ff], ["e", 0xffff55], ["f", 0xffffff],
];
const FORMATS: [string, string][] = [["obfuscated", "k"], ["bold", "l"], ["strikethrough", "m"], ["underlined", "n"], ["italic", "o"]];
/** 落としても文字は残るもの */
const DROPPED = new Set(["click_event", "clickEvent", "hover_event", "hoverEvent", "insertion", "font", "shadow_color"]);
const CONTENT_KEYS = new Set(["text", "translate", "with", "fallback", "score", "selector", "separator", "keybind", "nbt", "object", "type", "extra",
  // nbt・object のテキストの付属のキー（中身は未対応として報告する）
  "storage", "entity", "block", "interpret", "source", "plain", "atlas", "sprite", "player", "hat"]);

interface Style {
  color?: string;
  formats: Set<string>;
}

type Segment = { style: Style; part: RawTextPart };

function nearestColor(hex: number): string {
  let best = "f";
  let bestDist = Infinity;
  for (const [code, rgb] of PALETTE) {
    const d = [16, 8, 0].reduce((n, s) => n + (((hex >> s) & 255) - ((rgb >> s) & 255)) ** 2, 0);
    if (d < bestDist) [best, bestDist] = [code, d];
  }
  return best;
}

const asString = (t: NbtTag | undefined): string | undefined => (t?.type === "string" ? t.value : undefined);
const asBool = (t: NbtTag | undefined): boolean | undefined =>
  t === undefined ? undefined : t.type === "byte" || t.type === "int" || t.type === "short" ? t.value !== 0 : t.type === "string" ? t.value === "true" : undefined;

function styleCodes(s: Style): string {
  return (s.color ? `§${s.color}` : "") + FORMATS.filter(([k]) => s.formats.has(k)).map(([, c]) => `§${c}`).join("");
}

function sameStyle(a: Style, b: Style): boolean {
  return a.color === b.color && a.formats.size === b.formats.size && [...a.formats].every((f) => b.formats.has(f));
}

/** Java のテキストを rawtext に変える。unsupported があれば変換できない */
export function toRawText(value: NbtTag, opts: RawTextOptions): { rawtext: RawText; issues: TextIssue[] } {
  const issues: TextIssue[] = [];
  const note = (severity: TextIssue["severity"], message: string): void => {
    if (!issues.some((i) => i.message === message)) issues.push({ severity, message });
  };
  const segments: Segment[] = [];

  const walk = (tag: NbtTag, parent: Style, out: Segment[]): void => {
    if (tag.type === "string") {
      out.push({ style: parent, part: { text: tag.value } });
      return;
    }
    if (tag.type === "byte" || tag.type === "short" || tag.type === "int" || tag.type === "float" || tag.type === "double") {
      out.push({ style: parent, part: { text: String(tag.value) } });
      return;
    }
    if (tag.type === "long") {
      out.push({ style: parent, part: { text: String(tag.value) } });
      return;
    }
    if (tag.type === "list") {
      // 配列は、先頭の要素を親にして残りをその extra とみなす（Java の決まり）
      const [head, ...rest] = tag.value;
      if (!head) return;
      if (head.type === "compound") {
        const extra = head.value.get("extra");
        const merged = new Map(head.value);
        merged.set("extra", { type: "list", elementType: "compound", value: [...(extra?.type === "list" ? extra.value : []), ...rest] });
        walk({ type: "compound", value: merged }, parent, out);
      } else {
        walk(head, parent, out);
        for (const r of rest) walk(r, parent, out);
      }
      return;
    }
    if (tag.type === "compound" && tag.value.size === 1 && tag.value.has("")) {
      // 型の混ざったリストの要素は、キーが空の compound に包まれる（SNBT の決まり）
      walk(tag.value.get("")!, parent, out);
      return;
    }
    if (tag.type !== "compound") {
      note("unsupported", `テキストとして読めない値（${tag.type}）`);
      return;
    }
    const c = tag.value;
    const style: Style = { ...(parent.color ? { color: parent.color } : {}), formats: new Set(parent.formats) };
    const color = asString(c.get("color"));
    if (color !== undefined) {
      if (color === "reset") delete style.color;
      else if (COLORS[color]) style.color = COLORS[color];
      else if (/^#[0-9a-fA-F]{6}$/.test(color)) {
        style.color = nearestColor(parseInt(color.slice(1), 16));
        note("warning", `16進の色 ${color} を近い書式コードの色に寄せた`);
      } else note("warning", `不明な色 '${color}' を無視した`);
    }
    for (const [k] of FORMATS) {
      const b = asBool(c.get(k));
      if (b === true) style.formats.add(k);
      else if (b === false) style.formats.delete(k);
    }
    for (const key of c.keys()) {
      if (DROPPED.has(key)) note("warning", `BE にない '${key}' を落とした`);
      else if (!CONTENT_KEYS.has(key) && !COLORS[key] && !FORMATS.some(([f]) => f === key) && key !== "color") note("warning", `未知のキー '${key}' を無視した`);
    }
    if (c.has("text")) {
      const t = c.get("text")!;
      out.push({ style, part: { text: t.type === "string" ? t.value : String(t.value) } });
    } else if (c.has("translate")) {
      const key = asString(c.get("translate")) ?? "";
      note("warning", `翻訳キー '${key}' は BE で同じ文になるとは限らない`);
      const part: RawTextPart = { translate: key };
      const withTag = c.get("with");
      if (withTag?.type === "list" && withTag.value.length) {
        const args: RawTextPart[] = [];
        for (const w of withTag.value) {
          const inner: Segment[] = [];
          walk(w, { formats: new Set() }, inner);
          // 引数1つは rawtext の1要素にしかできないため、書式つきの複数の部分は文字列にまとめられない
          if (inner.length === 1 && inner[0]!.style.formats.size === 0 && !inner[0]!.style.color) args.push(inner[0]!.part);
          else if (inner.every((s) => s.part.text !== undefined)) args.push({ text: inner.map((s) => styleCodes(s.style) + s.part.text).join("§r") });
          else note("unsupported", "翻訳の引数に、複数の部分からなるスコアやセレクタがある");
        }
        part.with = { rawtext: args };
      }
      out.push({ style, part });
    } else if (c.has("score")) {
      const s = c.get("score");
      const name = asString(s?.type === "compound" ? s.value.get("name") : undefined);
      const objective = asString(s?.type === "compound" ? s.value.get("objective") : undefined);
      if (name === undefined || objective === undefined) note("unsupported", "score の name か objective がない");
      else {
        let holder = name;
        if (name.startsWith("@")) {
          const r = opts.selector(name);
          if (r.ok) holder = r.value;
          else note("unsupported", `score の対象のセレクタ: ${r.message}`);
        }
        out.push({ style, part: { score: { name: holder, objective } } });
      }
    } else if (c.has("selector")) {
      const r = opts.selector(asString(c.get("selector")) ?? "");
      if (r.ok) out.push({ style, part: { selector: r.value } });
      else note("unsupported", `テキストのセレクタ: ${r.message}`);
      if (c.has("separator")) note("warning", "selector の separator は BE にないため落とした");
    } else if (c.has("keybind")) {
      note("unsupported", "keybind は BE にない");
    } else if (c.has("nbt")) {
      note("unsupported", "nbt のテキストはランタイムで評価する（未実装）");
    } else if (c.has("object")) {
      note("unsupported", "object のテキストは BE にない");
    } else if (!c.has("extra")) {
      note("unsupported", "中身（text・translate・score・selector）のないテキスト");
    }
    const extra = c.get("extra");
    if (extra?.type === "list") for (const e of extra.value) walk(e, style, out);
  };

  walk(value, { formats: new Set() }, segments);

  // 書式が変わるところで §r と新しい書式を入れ、隣り合う文字列はつなげる
  const parts: RawTextPart[] = [];
  let current: Style = { formats: new Set() };
  const pushText = (text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.text !== undefined && Object.keys(last).length === 1) last.text += text;
    else parts.push({ text });
  };
  for (const seg of segments) {
    if (!sameStyle(seg.style, current)) {
      const codes = styleCodes(seg.style);
      const plainBefore = !current.color && current.formats.size === 0;
      // 色コードが書式を消すかは版によって違い得るため、書式が変わるたびに §r で消してから付け直す
      const prefix = (plainBefore ? "" : "§r") + codes;
      if (prefix) pushText(prefix);
      current = seg.style;
    }
    if (seg.part.text !== undefined && Object.keys(seg.part).length === 1) pushText(seg.part.text);
    else parts.push(seg.part);
  }
  if (parts.length === 0) parts.push({ text: "" });
  return { rawtext: { rawtext: parts }, issues };
}

/** rawtext を文字列にする。BE の構文と同じく JSON で書く */
export function formatRawText(r: RawText): string {
  return JSON.stringify(r);
}

/** 文字だけのテキスト（書式なし）にできるなら、その文字列（`scoreboard objectives add` の表示名など） */
export function plainText(r: RawText): string | undefined {
  if (r.rawtext.every((p) => p.text !== undefined && Object.keys(p).length === 1)) {
    const s = r.rawtext.map((p) => p.text).join("");
    return s.includes("§") ? undefined : s;
  }
  return undefined;
}
