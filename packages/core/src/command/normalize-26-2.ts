import type { CommandIR, ParsedNode } from "./parser.ts";

/** 26.1 → 26.2: team と waypoint の色引数の型名変更。 */
export function normalize26_2TeamColor(ir: CommandIR): CommandIR {
  const command = ir.command;
  if (!command) return ir;
  const nodes = command.nodes.map((node): ParsedNode => {
    if ((command.name === "team" || command.name === "waypoint") &&
        node.kind === "argument" && node.parser === "minecraft:color") {
      return { ...node, parser: "minecraft:team_color" };
    }
    return node;
  });
  return { ...ir, command: { ...command, nodes, ...(command.run ? { run: normalize26_2TeamColor(command.run) } : {}) } };
}
