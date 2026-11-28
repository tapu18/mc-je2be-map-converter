import type { CommandIR } from "../../command/parser.ts";
import type { RuntimeState } from "../../runtime/command.ts";
import { entityTarget, selectEntities, type ExecutionContext } from "../../runtime/context.ts";
import type { ExecutionResult } from "../../runtime/index.ts";
import { dataGetResult, executeStorageCommand } from "../storage/runtime.ts";
import { assessEntityNbt, entityNbtForm } from "./capability.ts";
import { readVirtualEntityPath } from "./virtual.ts";

const fail = (error: string): ExecutionResult => ({success: false, error});

/** `data get entity` and `data modify storage ... from entity` through the virtual NBT layer. */
export const entityNbtRuntime = {
  assess: assessEntityNbt,
  execute(state: RuntimeState, ir: CommandIR, context: ExecutionContext): ExecutionResult {
    const form = entityNbtForm(ir);
    if (form?.status !== "runtime") return fail(`unsupported entity NBT: ${form?.reason ?? "not an entity NBT command"}`);
    const {read} = form;
    const target = entityTarget(read.target.value)!;
    const entities = selectEntities(state.host, context, target, state.scores);
    if (!entities) return fail("unsupported entity selection");
    // Java's entity data source requires exactly one entity.
    if (!entities.length) return fail("no entity was found");
    if (entities.length > 1) return fail("only one entity is allowed");
    const path = read.path?.value?.kind === "nbtPath" ? read.path.value.path : [];
    const value = readVirtualEntityPath(state.host, entities[0]!, path);
    if (!value.ok) return fail(value.error);
    const nodes = ir.command!.nodes;
    if (read.kind === "get") {
      const scale = nodes[4]?.value?.kind === "number" ? nodes[4].value.value : undefined;
      return dataGetResult(value.value, scale);
    }
    // Hand the resolved value to the storage runtime as if it were written inline.
    const inline = {...read.target, name: "value", value: {kind: "nbt" as const, value: value.value}};
    return executeStorageCommand(state.storage, {...ir.command!, nodes: [...nodes.slice(0, read.sourceIndex), inline]});
  },
};

/** The reasoned rejection for an entity NBT command the runtime cannot evaluate, instead of delegating it. */
export function entityNbtRejection(ir: CommandIR): string | undefined {
  const form = entityNbtForm(ir);
  return form?.status === "unsupported" ? `unsupported entity NBT: ${form.reason}` : undefined;
}
