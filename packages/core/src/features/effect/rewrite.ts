import type { ParsedNode } from "../../command/parser.ts";
import { bedrockEffect } from "./ids.ts";

interface EffectEditor {
  replace(start: number, end: number, text: string): void;
  unsupported(message: string): void;
}

export function rewriteEffect(nodes: ParsedNode[], head: ParsedNode, ed: EffectEditor): void {
  const [action, targets, effect] = nodes;
  if (!action) return ed.unsupported("Java 側で effect の操作を指定する");
  if (effect?.value?.kind === "resource") {
    const id = bedrockEffect(effect.value.id);
    if (!id) return ed.unsupported(`BE の effect コマンドに対応するステータス効果がない: ${effect.value.id}`);
    ed.replace(effect.start, effect.end, id);
  }
  if (!targets) {
    ed.replace(head.end, action.end, " @s clear");
  } else {
    ed.replace(head.end, action.end, "");
    if (action.name === "clear") ed.replace(targets.end, targets.end, " clear");
  }
}
