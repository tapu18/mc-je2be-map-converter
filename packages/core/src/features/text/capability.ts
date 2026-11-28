import type { CommandIR, ParsedNode } from "../../command/parser.ts";
import type { CapabilityInput, CapabilityResult } from "../capability.ts";
import { invalidCapability } from "../capability.ts";
import { profileText, type TextProfile } from "./components.ts";

/** テキストを出すコマンド（tellraw、title の title・subtitle・actionbar） */
export interface TextCommandPlan {
  command: "tellraw" | "title";
  /** title のときの表示場所 */
  display?: "title" | "subtitle" | "actionbar";
  text: ParsedNode;
  profile: TextProfile;
}

/** nbt 成分をランタイムに回す理由。変換レポートのチェーンの理由にもこの文を出す */
export const nbtTextRuntimeReason =
  "テキストの nbt 成分（storage・エンティティ・ブロックの値の表示）は BE の rawtext にないため、ランタイムで値を読んで文字にする必要がある（仮想 NBT 層 #345 の後）";

export function textCommandPlan(ir: CommandIR): TextCommandPlan | undefined {
  let command = ir.command;
  // return run tellraw … も同じテキストを出す
  while (command?.name === "return" && command.run) command = command.run.command;
  if (command?.name !== "tellraw" && command?.name !== "title") return undefined;
  const text = command.nodes.find(n => n.value?.kind === "text");
  if (text?.value?.kind !== "text") return undefined;
  const display = command.name === "title" ? command.nodes.find(n => n.kind === "literal")?.name : undefined;
  return {
    command: command.name,
    ...(display === "title" || display === "subtitle" || display === "actionbar" ? { display } : {}),
    text, profile: profileText(text.value.value),
  };
}

/**
 * tellraw・title のテキストが BE の rawtext 1つで表せるか。
 * nbt 成分は値の読み出しが要るためランタイムに回すべきだが、ランタイムの実行は未実装（#345）なので unsupported にし、
 * 理由と必要な文脈を返す。keybind・object は BE にないため unsupported。
 * 書式・クリック・ホバーの欠落は rawtext.ts が警告にする。
 */
export function assessText(input: CapabilityInput): CapabilityResult<TextCommandPlan> {
  if (input.status === "invalid") return invalidCapability(input);
  const plan = textCommandPlan(input.ir);
  if (!plan) return { status: "unsupported", reason: "tellraw・title のテキストの解析結果がない", warnings: [], requiredContext: [] };
  const { kinds } = plan.profile;
  if (kinds.has("nbt")) {
    const context = [...plan.profile.nbtSources].map(s => (s === "storage" ? "storage" : s === "entity" ? "entityNbt" : "blockNbt"));
    return { status: "unsupported", reason: nbtTextRuntimeReason, warnings: [], requiredContext: context };
  }
  if (kinds.has("keybind")) return { status: "unsupported", reason: "keybind は BE の rawtext にない", warnings: [], requiredContext: [] };
  if (kinds.has("object")) return { status: "unsupported", reason: "object のテキストは BE の rawtext にない", warnings: [], requiredContext: [] };
  const context = kinds.has("score") || kinds.has("selector") ? ["executor", "scores"] : [];
  return { status: "native", reason: "BE の rawtext にある成分だけからなる", warnings: [], requiredContext: context, value: plan };
}
