import type { CommandIR, ParsedNode } from "../command/parser.ts";
import type { RuntimeState } from "./command.ts";
import { resolvePosition, type ExecutionContext, type ExecutionHost, type Position } from "./context.ts";
import type { ExecutionResult } from "./index.ts";

export function blockPosition(node: ParsedNode, source: string, context: ExecutionContext, host?: ExecutionHost): Position {
  return resolvePosition(node, source, context, host).map(Math.floor) as Position;
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
