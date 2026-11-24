import type { CommandIR } from "../command/parser.ts";
import type { ExecutionResult } from "./index.ts";
import { setNbtPath } from "./nbt-mutation.ts";
import { getNbtPath } from "./nbt-path.ts";
import { executeScoreCommand } from "./score-command.ts";
import { Scoreboard } from "./scores.ts";
import { executeStorageCommand, StorageState } from "./storage-command.ts";

/** Runtime state shared across commands. */
export class RuntimeState {
  readonly scores = new Scoreboard();
  readonly storage = new StorageState();
}

/** Execute supported single-context forms. Unknown steps are rejected before executing the command. */
export function executeCommand(state: RuntimeState, ir: CommandIR): ExecutionResult {
  const fail = (error: string): ExecutionResult => ({success: false, error});
  type Store = {id: string; path: Extract<NonNullable<typeof ir.context[number]["nodes"][number]["value"]>, {kind: "nbtPath"}>["path"]; scale: number};
  const stores: Store[] = [];
  if (ir.context.length > 1) return fail("unsupported execute chain");
  for (const step of ir.context) {
    const [a, b, idNode, pathNode, typeNode, scaleNode] = step.nodes;
    const id = idNode?.value, p = pathNode?.value;
    if ((step.kind === "if" || step.kind === "unless") && a?.name === "data" && b?.name === "storage" && id?.kind === "resource" && p?.kind === "nbtPath") {
      const found = getNbtPath(state.storage.get(id.id), p.path).length > 0;
      if (found !== (step.kind === "if")) return fail("condition failed");
    } else if (step.kind === "store" && a?.name === "result" && b?.name === "storage" && id?.kind === "resource" && p?.kind === "nbtPath" && typeNode?.name === "int" && scaleNode?.value?.kind === "number") {
      stores.push({id: id.id, path: p.path, scale: scaleNode.value.value});
    } else return fail("unsupported execute step");
  }
  if (!ir.command) return fail("missing command");
  const outcome = ir.command.name === "scoreboard" ? executeScoreCommand(state.scores, ir.command) : executeStorageCommand(state.storage, ir.command);
  if (!outcome.success && outcome.error.startsWith("unsupported")) return outcome;
  for (const store of stores.reverse()) {
    const n = Math.trunc((outcome.success ? outcome.result : 0) * store.scale);
    setNbtPath(state.storage.writable(store.id), store.path, {type: "int", value: Math.max(-2147483648, Math.min(2147483647, n))});
  }
  return outcome;
}
