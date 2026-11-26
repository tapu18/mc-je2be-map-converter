import type { CommandIR, ParsedNode } from "../command/parser.ts";
import type { RuntimeState } from "./command.ts";
import { resolvePosition, type ExecutionContext, type ExecutionHost, type Position } from "./context.ts";
import type { ExecutionResult } from "./index.ts";
import { equalNbt } from "./nbt-mutation.ts";

export function blockPosition(node: ParsedNode, source: string, context: ExecutionContext, host?: ExecutionHost): Position {
  return resolvePosition(node, source, context, host).map(Math.floor) as Position;
}

/** Compare inclusive source bounds against the region starting at destination. */
export function compareBlockRegions(host: ExecutionHost, dimension: string, start: Position, end: Position, destination: Position, masked: boolean): number | false | Extract<ExecutionResult, {success: false}> {
  const min = start.map((value, axis) => Math.min(value, end[axis]!)) as Position;
  const size = start.map((value, axis) => Math.abs(value - end[axis]!) + 1) as Position;
  const [width, height, depth] = size;
  if (width * height * depth > 32768) return {success: false, error: "block region exceeds 32768 blocks"};
  if ([start, end, destination].some(position => !host.readBlock(dimension, position))) {
    return {success: false, error: "block position not loaded"};
  }
  let count = 0;
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const left = host.readBlock(dimension, [min[0] + x, min[1] + y, min[2] + z]);
        if (!left) return {success: false, error: "block position not loaded"};
        if (masked && left.id === "minecraft:air") continue;
        const right = host.readBlock(dimension, [destination[0] + x, destination[1] + y, destination[2] + z]);
        if (!right) return {success: false, error: "block position not loaded"};
        if (left.id !== right.id || Object.keys(left.states).length !== Object.keys(right.states).length
          || !Object.entries(left.states).every(([key, value]) => right.states[key] === value)) return false;
        if (left.nbt && (!right.nbt || !equalNbt(left.nbt, right.nbt))) return false;
        count++;
      }
    }
  }
  return count;
}

export function executeWorldCommand(state: RuntimeState, command: NonNullable<CommandIR["command"]>, context: ExecutionContext, source: string): ExecutionResult | undefined {
  if (command.name === "setblock" && state.host) {
    const [position, block, mode] = command.nodes;
    const value = block?.value;
    if (position?.value?.kind === "coordinates" && position.value.coordinates.length === 3 && value?.kind === "block"
      && !value.nbt && !value.tag && (!mode || mode.name === "replace") && command.nodes.length <= 3) {
      return state.host.writeBlock(context.dimension, blockPosition(position, source, context, state.host), value);
    }
  }
  return state.host?.runNative?.(command, context, source);
}
