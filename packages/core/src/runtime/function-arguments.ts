import type { CommandIR, ParsedNode } from "../command/parser.ts";
import type { NbtCompound, NbtTag } from "../nbt/nbt.ts";
import type { RuntimeState } from "./command.ts";
import { entityTarget, selectEntities, type ExecutionContext } from "./context.ts";
import { getNbtPath } from "./nbt-path.ts";
import { blockPosition } from "./world.ts";

function sourceNbt(state: RuntimeState, type: string, node: ParsedNode, source: string, context: ExecutionContext): NbtTag | undefined {
  const value = node.value;
  if (type === "storage" && value?.kind === "resource") return state.storage.get(value.id);
  if (type === "entity") {
    const target = entityTarget(value);
    if (!target) return;
    const entities = selectEntities(state.host, context, target, state.scores);
    if (entities?.length === 1) return state.host?.readEntityNbt?.(entities[0]!.id);
  }
  if (type === "block" && value?.kind === "coordinates" && value.coordinates.length === 3) {
    const position = blockPosition(node, source, context, state.host);
    const nbt = state.host?.readBlock(context.dimension, position)?.nbt;
    if (nbt?.type !== "compound") return;
    const data = new Map(nbt.value);
    for (const [index, key] of ["x", "y", "z"].entries()) data.set(key, {type: "int", value: position[index]!});
    return {type: "compound", value: data};
  }
}

type FunctionArguments = { ok: true; value?: NbtCompound } | { ok: false; reason: string };

export function readFunctionArguments(ir: CommandIR, state: RuntimeState, context: ExecutionContext): FunctionArguments {
  const [, mode, type, target, path] = ir.command!.nodes;
  if (!mode) return {ok: true};
  if (mode.value?.kind === "nbt" && mode.value.value.type === "compound") return {ok: true, value: mode.value.value};
  if (mode.name !== "with" || !type || !target) return {ok: false, reason: "unsupported function arguments"};
  const root = sourceNbt(state, type.name, target, ir.source, context);
  if (!root) return {ok: false, reason: `function ${type.name} arguments unavailable`};
  const values = path?.value?.kind === "nbtPath" ? getNbtPath(root, path.value.path) : [root];
  const value = values[0];
  if (values.length !== 1 || value?.type !== "compound") return {ok: false, reason: "function argument path must select one compound"};
  return {ok: true, value};
}
