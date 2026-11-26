import type { CommandIR, ParsedNode } from "./parser.ts";

/** 1.21.8 → 1.21.9: スポーンの yaw を保ち、明示した角度に絶対 pitch 0 を加える。 */
export function normalize1_21_9SpawnRotation(ir: CommandIR): CommandIR {
  const command = ir.command;
  if (!command) return ir;
  const nodes = command.name === "setworldspawn" || command.name === "spawnpoint"
    ? command.nodes.map((node): ParsedNode => {
      if (node.kind !== "argument" || node.name !== "angle" || node.parser !== "minecraft:angle" || node.value?.kind !== "coordinates") return node;
      return {
        ...node, name: "rotation", parser: "minecraft:rotation",
        value: { kind: "coordinates", coordinates: [...node.value.coordinates, { kind: "absolute", value: 0 }] },
      };
    })
    : command.nodes;
  return { ...ir, command: { ...command, nodes, ...(command.run ? { run: normalize1_21_9SpawnRotation(command.run) } : {}) } };
}
