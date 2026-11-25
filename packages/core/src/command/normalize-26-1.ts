import type { CommandIR, ParsedNode } from "./parser.ts";

/** 1.21.11 → 26.1: time set の固定時刻名を timemarker 引数にする。 */
export function normalize26_1Time(ir: CommandIR): CommandIR {
  const command = ir.command;
  if (!command) return ir;
  const nodes = command.name === "time" && command.nodes[0]?.kind === "literal" && command.nodes[0].name === "set"
    ? command.nodes.map((node, index): ParsedNode => index === 1 && node.kind === "literal" && ["day", "noon", "night", "midnight"].includes(node.name)
      ? { ...node, kind: "argument", name: "timemarker", parser: "minecraft:resource_location", value: { kind: "resource", id: `minecraft:${node.name}`, tag: false } }
      : node)
    : command.nodes;
  return { ...ir, command: { ...command, nodes, ...(command.run ? { run: normalize26_1Time(command.run) } : {}) } };
}
