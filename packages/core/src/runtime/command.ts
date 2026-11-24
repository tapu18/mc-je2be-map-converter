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
  readonly functions = new Map<string, CommandIR[]>();
  readonly functionTags = new Map<string, string[]>();
}

/** Execute supported single-context forms. Unknown steps are rejected before executing the command. */
export function executeCommand(state: RuntimeState, ir: CommandIR): ExecutionResult {
  const outcome = execute(state, ir, 0);
  return outcome.success ? {success: true, result: outcome.result} : {success: false, error: outcome.error};
}

type Outcome = ExecutionResult & {returned?: boolean; explicitReturn?: boolean};
function execute(state: RuntimeState, ir: CommandIR, depth: number): Outcome {
  const fail = (error: string): ExecutionResult => ({success: false, error});
  type Store = {kind: "storage"; id: string; path: Extract<NonNullable<typeof ir.context[number]["nodes"][number]["value"]>, {kind: "nbtPath"}>["path"]; scale: number; success: boolean} | {kind: "score"; holder: string; objective: string; success: boolean};
  const stores: Store[] = [];
  // Validate the entire chain before evaluating any condition or performing writes.
  for (const step of ir.context) {
    const [a, b, idNode, pathNode, typeNode, scaleNode] = step.nodes;
    const storagePath = idNode?.value?.kind === "resource" && pathNode?.value?.kind === "nbtPath";
    const condition = (step.kind === "if" || step.kind === "unless") && a?.name === "data" && b?.name === "storage" && storagePath;
    const store = step.kind === "store" && (a?.name === "result" || a?.name === "success") && b?.name === "storage" && storagePath && typeNode?.name === "int" && scaleNode?.value?.kind === "number";
    const scoreStore = step.kind === "store" && (a?.name === "result" || a?.name === "success") && b?.name === "score" && idNode?.value?.kind === "name" && pathNode?.value?.kind === "word";
    const scoreCondition = (step.kind === "if" || step.kind === "unless") && a?.name === "score" && b?.value?.kind === "name" && idNode?.value?.kind === "word" && ((pathNode?.name === "matches" && typeNode?.value?.kind === "range") || (["=", "<", "<=", ">", ">="].includes(pathNode?.name ?? "") && typeNode?.value?.kind === "name" && scaleNode?.value?.kind === "word"));
    const functionCondition = (step.kind === "if" || step.kind === "unless") && a?.name === "function" && b?.value?.kind === "resource";
    if (!condition && !store && !scoreStore && !scoreCondition && !functionCondition) return fail("unsupported execute step");
  }
  let conditionFailed = false;
  for (const step of ir.context) {
    const [a, b, idNode, pathNode, typeNode, scaleNode] = step.nodes;
    const id = idNode?.value, p = pathNode?.value;
    if ((step.kind === "if" || step.kind === "unless") && a?.name === "function" && b?.value?.kind === "resource") {
      const target = b.value;
      const names = target.tag ? state.functionTags.get(target.id) : [target.id];
      if (!names || names.some(name => !state.functions.has(name))) return fail("unknown function");
      let matched = false;
      for (const name of names) {
        const node = {...b, value: {...target, id: name, tag: false}};
        const result = execute(state, {source: ir.source, context: [], command: {name: "function", nodes: [node]}}, depth);
        if (!result.success && result.error.startsWith("unsupported")) return result;
        if (result.success && result.explicitReturn === true && result.result !== 0) { matched = true; break; }
      }
      if (matched !== (step.kind === "if")) { conditionFailed = true; break; }
    } else if ((step.kind === "if" || step.kind === "unless") && a?.name === "data" && b?.name === "storage" && id?.kind === "resource" && p?.kind === "nbtPath") {
      const found = getNbtPath(state.storage.get(id.id), p.path).length > 0;
      if (found !== (step.kind === "if")) { conditionFailed = true; break; }
    } else if (step.kind === "store" && (a?.name === "result" || a?.name === "success") && b?.name === "storage" && id?.kind === "resource" && p?.kind === "nbtPath" && typeNode?.name === "int" && scaleNode?.value?.kind === "number") {
      stores.push({kind: "storage", id: id.id, path: p.path, scale: scaleNode.value.value, success: a.name === "success"});
    } else if (step.kind === "store" && (a?.name === "result" || a?.name === "success") && b?.name === "score" && id?.kind === "name" && p?.kind === "word") {
      stores.push({kind: "score", holder: id.value, objective: p.value, success: a.name === "success"});
    } else if ((step.kind === "if" || step.kind === "unless") && a?.name === "score" && b?.value?.kind === "name" && id?.kind === "word" && pathNode?.name === "matches" && typeNode?.value?.kind === "range") {
      const value = state.scores.get(b.value.value, id.value), range = typeNode.value.range;
      const matches = value !== undefined && (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
      if (matches !== (step.kind === "if")) { conditionFailed = true; break; }
    } else if ((step.kind === "if" || step.kind === "unless") && a?.name === "score" && b?.value?.kind === "name" && id?.kind === "word" && typeNode?.value?.kind === "name" && scaleNode?.value?.kind === "word" && pathNode) {
      const lhs = state.scores.get(b.value.value, id.value), rhs = state.scores.get(typeNode.value.value, scaleNode.value.value);
      const matches = lhs !== undefined && rhs !== undefined && (pathNode.name === "=" ? lhs === rhs : pathNode.name === "<" ? lhs < rhs : pathNode.name === "<=" ? lhs <= rhs : pathNode.name === ">" ? lhs > rhs : lhs >= rhs);
      if (matches !== (step.kind === "if")) { conditionFailed = true; break; }
    } else return fail("unsupported execute step");
  }
  if (!ir.command && !conditionFailed) return fail("missing command");
  let outcome: Outcome;
  const command = ir.command;
  if (conditionFailed) outcome = fail("condition failed");
  else if (!command) outcome = fail("missing command");
  else if (command.name === "return") {
    const value = command.nodes[0]?.value;
    if (command.run) outcome = {...execute(state, command.run, depth), returned: true};
    else if (value?.kind === "number") outcome = {success: true, result: value.value, returned: true};
    else if (command.nodes[0]?.name === "fail") outcome = {success: false, error: "return fail", returned: true};
    else outcome = fail("unsupported return");
  } else if (command.name === "function") {
    const target = command.nodes[0]?.value;
    if (target?.kind !== "resource" || depth >= 128) outcome = fail("unsupported function");
    else {
      const names = target.tag ? state.functionTags.get(target.id) : [target.id];
      if (!names || names.some(name => !state.functions.has(name))) outcome = fail("unknown function");
      else {
        let total = 0;
        let successes = 0;
        let single: Outcome | undefined;
        for (const name of names) {
          let count = 0;
          let returned: Outcome | undefined;
          for (const line of state.functions.get(name)!) {
            const result = execute(state, line, depth + 1);
            count++;
            if (!result.success && result.error.startsWith("unsupported")) { returned = result; break; }
            if (result.returned) { returned = result; break; }
          }
          if (returned && !returned.success && returned.error.startsWith("unsupported")) { single = returned; break; }
          const result: Outcome = returned ? (returned.success ? {success: true, result: returned.result, explicitReturn: true} : {success: false, error: returned.error, explicitReturn: true}) : {success: true, result: count};
          single = result;
          if (result.success) { successes++; total += result.result; }
        }
        outcome = target.tag ? (single && !single.success && single.error.startsWith("unsupported") ? single : successes ? {success: true, result: total} : fail("function tag failed")) : single ?? fail("unknown function");
      }
    }
  } else outcome = command.name === "scoreboard" ? executeScoreCommand(state.scores, command) : executeStorageCommand(state.storage, command);
  if (!outcome.success && outcome.error.startsWith("unsupported")) return outcome;
  for (const store of stores.reverse()) {
    const value = outcome.success ? (store.success ? 1 : outcome.result) : 0;
    if (store.kind === "score") state.scores.set(store.holder, store.objective, value);
    else {
      const n = Math.trunc(value * store.scale);
      setNbtPath(state.storage.writable(store.id), store.path, {type: "int", value: Math.max(-2147483648, Math.min(2147483647, n))});
    }
  }
  return outcome;
}
