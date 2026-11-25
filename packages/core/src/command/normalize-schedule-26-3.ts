import { readResourceLocation } from "./arguments.ts";
import type { CommandNormalization } from "./normalize-command.ts";
import { CommandSyntaxError, StringReader } from "./reader.ts";
import type { CommandIR, ParsedNode } from "./parser.ts";

export type ScheduleNormalization = CommandNormalization;

/** 26.2 → 26.3: schedule clear の文字列を ID として扱える場合だけ正規化する。 */
export function normalize26_3Schedule(ir: CommandIR): ScheduleNormalization {
  const command = ir.command;
  if (!command) return { ok: true, ir };
  let failure: Extract<ScheduleNormalization, { ok: false }> | undefined;
  const nodes = command.name === "schedule" && command.nodes[0]?.name === "clear" ? command.nodes.map((node): ParsedNode => {
    if (node.kind !== "argument" || node.name !== "function" || node.parser !== "brigadier:string" || node.value?.kind !== "string") return node;
    const reader = new StringReader(node.value.value);
    try {
      const id = readResourceLocation(reader);
      // 旧版は文字列そのものを照合する。暗黙の名前空間を補うと照合結果が変わりうる。
      if (reader.canRead() || id !== node.value.value) throw reader.error("同じ ID として表せない");
      return { ...node, parser: "minecraft:resource_location", value: { kind: "resource", id, tag: false } };
    } catch (e) {
      if (!(e instanceof CommandSyntaxError)) throw e;
      failure = { ok: false, reason: "schedule clear の文字列を resource location に変換できない", start: node.start, end: node.end };
      return node;
    }
  }) : command.nodes;
  if (failure) return failure;
  const nested = command.run ? normalize26_3Schedule(command.run) : undefined;
  if (nested && !nested.ok) return nested;
  return { ok: true, ir: { ...ir, command: { ...command, nodes, ...(nested?.ok ? { run: nested.ir } : {}) } } };
}
