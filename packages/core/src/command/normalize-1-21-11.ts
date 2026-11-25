import type { CommandIR, ParsedNode } from "./parser.ts";

/** 1.21.10 → 1.21.11: worldborder の秒数を tick に直す。 */
export function normalize1_21_11Worldborder(ir: CommandIR): CommandIR {
  const command = ir.command;
  if (!command) return ir;
  const nodes = command.name === "worldborder" ? command.nodes.map((node): ParsedNode => {
    if (node.kind === "argument" && node.name === "time" && node.parser === "brigadier:integer" && node.value?.kind === "number") {
      return { ...node, parser: "minecraft:time", value: { kind: "time", ticks: node.value.value * 20 } };
    }
    return node;
  }) : command.nodes;
  return { ...ir, command: { ...command, nodes, ...(command.run ? { run: normalize1_21_11Worldborder(command.run) } : {}) } };
}
