// Java のテキスト（text component）の中身の種類・書式・extra の深さを数える（#347）。
// 書き換え（rawtext.ts）とコーパス集計（tools/text-components.ts）で同じ見方を使う。
// 種類の決め方は rawtext.ts と同じで、キーの優先順位は text → translate → score → selector → keybind → nbt → object。
import type { NbtTag } from "../../nbt/nbt.ts";

export const textKinds = ["text", "translate", "score", "selector", "keybind", "nbt", "object", "empty"] as const;
export type TextKind = (typeof textKinds)[number];

/** 書式・付属のキー。color は名前と16進に分ける */
export const textStyles = [
  "color", "color_hex", "bold", "italic", "underlined", "strikethrough", "obfuscated",
  "font", "insertion", "shadow_color", "click", "hover", "with", "separator", "fallback",
] as const;
export type TextStyle = (typeof textStyles)[number];

export interface TextProfile {
  /** 現れた中身の種類（translate の引数の中も含む） */
  kinds: Set<TextKind>;
  /** 現れた書式・付属のキー */
  styles: Set<TextStyle>;
  /** nbt の読み先（storage・entity・block） */
  nbtSources: Set<"storage" | "entity" | "block">;
  /** extra の入れ子の最大の深さ。根だけなら 0。配列 [a, b] は a の extra に b を持つとみなすため 1 */
  extraDepth: number;
}

const STYLE_KEYS: Record<string, TextStyle> = {
  bold: "bold", italic: "italic", underlined: "underlined", strikethrough: "strikethrough", obfuscated: "obfuscated",
  font: "font", insertion: "insertion", shadow_color: "shadow_color",
  click_event: "click", clickEvent: "click", hover_event: "hover", hoverEvent: "hover",
  with: "with", separator: "separator", fallback: "fallback",
};

/** compound のテキストの中身の種類。rawtext.ts の分岐と同じ順で決める */
export function textKind(c: Map<string, NbtTag>): TextKind {
  for (const kind of ["text", "translate", "score", "selector", "keybind", "nbt", "object"] as const) if (c.has(kind)) return kind;
  return "empty";
}

export function profileText(value: NbtTag): TextProfile {
  const profile: TextProfile = { kinds: new Set(), styles: new Set(), nbtSources: new Set(), extraDepth: 0 };
  const walk = (tag: NbtTag, depth: number): void => {
    profile.extraDepth = Math.max(profile.extraDepth, depth);
    if (tag.type === "list") {
      const [head, ...rest] = tag.value;
      if (!head) return;
      walk(head, depth);
      for (const r of rest) walk(r, depth + 1);
      return;
    }
    if (tag.type === "compound" && tag.value.size === 1 && tag.value.has("")) return walk(tag.value.get("")!, depth);
    if (tag.type !== "compound") {
      profile.kinds.add("text");
      return;
    }
    const c = tag.value;
    const kind = textKind(c);
    profile.kinds.add(kind);
    if (kind === "nbt") for (const source of ["storage", "entity", "block"] as const) if (c.has(source)) profile.nbtSources.add(source);
    const color = c.get("color");
    if (color?.type === "string") profile.styles.add(color.value.startsWith("#") ? "color_hex" : "color");
    for (const key of c.keys()) {
      const style = STYLE_KEYS[key];
      if (style) profile.styles.add(style);
    }
    const args = c.get("with");
    if (kind === "translate" && args?.type === "list") for (const a of args.value) walk(a, depth);
    const extra = c.get("extra");
    if (extra?.type === "list") for (const e of extra.value) walk(e, depth + 1);
  };
  walk(value, 0);
  return profile;
}
