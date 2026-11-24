import type { ParsedNode } from "../../command/parser.ts";
import type { CapabilityInput, CapabilityResult } from "../capability.ts";
import { invalidCapability } from "../capability.ts";

export interface SoundPlan {
  id: string;
  sound: ParsedNode;
  category: ParsedNode | undefined;
  targets: ParsedNode | undefined;
  hasPosition: boolean;
}

/** 対応表を注入し、書き換えと将来のランタイムで同じ判定を使えるようにする。 */
export function assessSound(input: CapabilityInput, soundMapping: (id: string) => string | undefined): CapabilityResult<SoundPlan> {
  if (input.status === "invalid") return invalidCapability(input);
  const command = input.ir.command;
  const nodes = command?.nodes ?? [];
  const sound = nodes.find((n) => n.kind === "argument" && n.name === "sound");
  if (command?.name !== "playsound" || sound?.value?.kind !== "resource") {
    return { status: "unsupported", reason: "playsound の解析結果がない", warnings: [], requiredContext: [] };
  }
  const id = soundMapping(sound.value.id);
  if (!id) return { status: "unsupported", reason: `BE に対応のないサウンド ${sound.value.id}`, warnings: [], requiredContext: [] };
  const category = nodes.find((n) => n.kind === "literal");
  const targets = nodes.find((n) => n.kind === "argument" && n.name === "targets");
  return {
    status: "native", reason: "対応表にサウンドがある", requiredContext: ["position"],
    warnings: [
      `BE の playsound では Java のサウンドカテゴリ ${category?.name ?? "master（既定）"} を指定できない`,
      "対応する音や、音量・ピッチ・距離による聞こえ方は版によって変わり得る",
    ],
    value: { id, sound, category, targets, hasPosition: nodes.some((n) => n.kind === "argument" && n.name === "pos") },
  };
}
