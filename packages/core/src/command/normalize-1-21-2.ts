import type { CommandIR, ParsedNode } from "./parser.ts";

/** 1.21.1 → 1.21.2 の advancement / recipe / experience 引数。 */
export function normalize1_21_2Arguments(ir: CommandIR): CommandIR {
  const command = ir.command;
  if (!command) return ir;
  const nodes = command.nodes.map((node): ParsedNode => {
    if (node.kind !== "argument") return node;
    if ((command.name === "experience" || command.name === "xp") && node.name === "targets") return { ...node, name: "target" };
    if ((command.name === "advancement" && node.name === "advancement" || command.name === "recipe" && node.name === "recipe") && node.parser === "minecraft:resource_location") {
      return { ...node, parser: "minecraft:resource_key" };
    }
    return node;
  });
  return { ...ir, command: { ...command, nodes, ...(command.run ? { run: normalize1_21_2Arguments(command.run) } : {}) } };
}
