import type { CommandIR } from "../command/parser.ts";
import type { ExecutionResult } from "./index.ts";
import { scoreRuntime } from "../features/score/registration.ts";
import { Scoreboard } from "./scores.ts";
import { StorageState } from "../features/storage/runtime.ts";
import { storageRuntime } from "../features/storage/registration.ts";
import { scheduleRuntime } from "../features/schedule/registration.ts";
import { ScheduleState } from "../features/schedule/runtime.ts";

import { defaultExecutionContext, dimensionId, type ExecutionContext, type ExecutionHost } from "./context.ts";
import { applyStores, compileModifier, type ExecuteBranch } from "./execute-steps.ts";
import { executeWorldCommand } from "./world.ts";

export type { ExecutionContext } from "./context.ts";
export { defaultExecutionContext } from "./context.ts";

export const runtimeFamilies = [scoreRuntime, storageRuntime, scheduleRuntime] as const;

/** Runtime state shared across commands. */
export class RuntimeState {
  readonly scores = new Scoreboard();
  readonly storage = new StorageState();
  readonly schedule = new ScheduleState();
  readonly functions = new Map<string, CommandIR[]>();
  readonly functionTags = new Map<string, string[]>();
  readonly host: ExecutionHost | undefined;

  constructor(host?: ExecutionHost) {
    this.host = host;
  }
}

/** Run one tick's callbacks in their registration order using the game loop's execution source. */
export function advanceScheduledTick(state: RuntimeState, budget: ExecutionBudget = defaultExecutionBudget, context: ExecutionContext = defaultExecutionContext()): {id: string; result: ExecutionResult}[] {
  const outcomes: {id: string; result: ExecutionResult}[] = [];
  for (const target of state.schedule.advanceTick()) {
    const names = target.tag ? state.functionTags.get(target.id) ?? [] : [target.id];
    for (const id of names) {
      if (!state.functions.has(id)) continue;
      const ir: CommandIR = {source: `function ${id}`, context: [], command: {name: "function", nodes: [
        {kind: "argument", name: "name", start: 9, end: 9 + id.length, value: {kind: "resource", id, tag: false}},
      ]}};
      outcomes.push({id, result: executeCommand(state, ir, budget, context)});
    }
  }
  return outcomes;
}

/** Per-invocation safety limits, independent of Java's unmeasured limits. */
export interface ExecutionBudget { instructions: number; depth: number; branches: number }
export const defaultExecutionBudget: ExecutionBudget = {instructions: 100000, depth: 128, branches: 10000};
export type Outcome = ExecutionResult & {returned?: boolean; explicitReturn?: boolean};
type Request = {kind: "command"; ir: CommandIR; depth: number; context: ExecutionContext} | {kind: "branch"};
export type Frame<T = Outcome> = Generator<Request, T, Outcome>;

/** Execute supported commands using an explicit stack of suspended frames. */
export function executeCommand(state: RuntimeState, ir: CommandIR, budget: ExecutionBudget = defaultExecutionBudget, context: ExecutionContext = defaultExecutionContext()): ExecutionResult {
  if (Object.values(budget).some(limit => !Number.isSafeInteger(limit) || limit < 0)) return {success: false, error: "invalid execution budget"};
  const frames: Frame[] = [];
  let instructions = 0, branches = 0;
  let request: Request = {kind: "command", ir, depth: 0, context: {...context, dimension: dimensionId(context.dimension)}};
  let value: Outcome = {success: true, result: 0};
  while (true) {
    if (request.kind === "command") {
      if (++instructions > budget.instructions) return {success: false, error: "instruction budget exceeded"};
      if (request.depth > budget.depth) return {success: false, error: "depth budget exceeded"};
      frames.push(execute(state, request.ir, request.depth, request.context));
    } else if (++branches > budget.branches) return {success: false, error: "branch budget exceeded"};
    while (frames.length) {
      const next = frames[frames.length - 1]!.next(value);
      if (!next.done) { request = next.value; break; }
      value = next.value;
      frames.pop();
    }
    if (!frames.length) return value.success ? {success: true, result: value.result} : {success: false, error: value.error};
  }
}

function* execute(state: RuntimeState, ir: CommandIR, depth: number, context: ExecutionContext): Frame {
  const modifiers = ir.context.map(step => compileModifier(step, state.host));
  // Validate the whole chain before any condition can run a function or write a result.
  if (modifiers.some(modifier => !modifier)) return fail("unsupported execute step");
  let branches: ExecuteBranch[] = [{context, stores: []}];
  let failure: Outcome = fail("no execution targets");
  for (const modifier of modifiers) {
    const next: ExecuteBranch[] = [];
    for (const branch of branches) {
      const result = yield* modifier!(state, branch, depth, ir.source);
      if ("success" in result) {
        if (result.error !== "condition failed") return result;
        applyStores(branch, result);
        failure = result;
      } else {
        for (const child of result) next.push(child);
      }
    }
    branches = next;
  }

  if (branches.length && !ir.command) return fail("missing command");
  let total = 0;
  let succeeded = false;
  let last: Outcome = failure;
  for (const branch of branches) {
    const outcome = yield* executeTerminal(state, ir, depth, branch.context);
    if (!outcome.success && outcome.error.startsWith("unsupported")) return outcome;
    applyStores(branch, outcome);
    if (outcome.returned) return outcome;
    last = outcome;
    if (outcome.success) { total += outcome.result; succeeded = true; }
  }
  return branches.length <= 1 ? last : succeeded ? {success: true, result: total} : last;
}

const fail = (error: string): ExecutionResult => ({success: false, error});

function* executeTerminal(state: RuntimeState, ir: CommandIR, depth: number, context: ExecutionContext): Frame {
  let outcome: Outcome;
  const command = ir.command;
  if (!command) outcome = fail("missing command");
  else if (command.name === "return") {
    const value = command.nodes[0]?.value;
    if (command.run) outcome = {...(yield {kind: "command", ir: command.run, depth, context}), returned: true};
    else if (value?.kind === "number") outcome = {success: true, result: value.value, returned: true};
    else if (command.nodes[0]?.name === "fail") outcome = {success: false, error: "return fail", returned: true};
    else outcome = fail("unsupported return");
  } else if (command.name === "function") {
    const target = command.nodes[0]?.value;
    if (target?.kind !== "resource") outcome = fail("unsupported function");
    else {
      const names = target.tag ? state.functionTags.get(target.id) : [target.id];
      if (!names || names.some(name => !state.functions.has(name))) outcome = fail("unknown function");
      else {
        let total = 0;
        let successes = 0;
        let single: Outcome | undefined;
        for (const name of names) {
          yield {kind: "branch"};
          let count = 0;
          let returned: Outcome | undefined;
          for (const line of state.functions.get(name)!) {
            const result = yield {kind: "command", ir: line, depth: depth + 1, context};
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
  } else {
    const family = runtimeFamilies.find(entry => entry.assess({status: "parsed", ir}).status === "runtime");
    outcome = family ? family.execute(state, ir, context)
      : executeWorldCommand(state, command, context, ir.source) ?? fail("unsupported command");
  }
  return outcome;
}
