import type { CommandNormalization } from "./normalize-command.ts";
import type { CommandIR, ParsedNode } from "./parser.ts";

/** 1.21.10 → 1.21.11: worldborder の秒数を tick に直す。 */
export function normalize1_21_11Worldborder(ir: CommandIR): CommandNormalization {
  const command = ir.command;
  if (!command) return { ok: true, ir };
  let failure: Extract<CommandNormalization, { ok: false }> | undefined;
  const nodes = command.name === "worldborder" ? command.nodes.map((node): ParsedNode => {
    if (node.kind === "argument" && node.name === "time" && node.parser === "brigadier:integer" && node.value?.kind === "number") {
      const ticks = node.value.value * 20;
      // Java の time 引数は単精度で計算し、符号付き 32 bit の tick 数に丸める。
      if (ticks > 2_147_483_647 || Math.fround(ticks) !== ticks) {
        failure = { ok: false, reason: "worldborder の秒数を Java の tick で正確に表せない", start: node.start, end: node.end };
        return node;
      }
      return { ...node, parser: "minecraft:time", value: { kind: "time", ticks } };
    }
    return node;
  }) : command.nodes;
  if (failure) return failure;
  const nested = command.run ? normalize1_21_11Worldborder(command.run) : undefined;
  if (nested && !nested.ok) return nested;
  return { ok: true, ir: { ...ir, command: { ...command, nodes, ...(nested ? { run: nested.ir } : {}) } } };
}
