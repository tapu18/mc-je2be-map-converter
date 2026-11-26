import type { CommandIR } from "../../command/parser.ts";
import type { RuntimeState } from "../../runtime/command.ts";
import type { ExecutionResult } from "../../runtime/index.ts";
import { invalidCapability, type CapabilityInput, type CapabilityResult } from "../capability.ts";

type ScheduleCommand =
  | { kind: "clear"; id: string }
  | { kind: "function"; id: string; tag: boolean; ticks: number; replace: boolean };

function readSchedule(ir: CommandIR): ScheduleCommand | undefined {
  if (ir.command?.name !== "schedule") return;
  const [op, target, delay, mode] = ir.command.nodes;
  if (target?.value?.kind !== "resource") return;
  const {id, tag} = target.value;
  if (op?.name === "clear" && !tag && ir.command.nodes.length === 2) return {kind: "clear", id};
  if (op?.name === "function" && delay?.value?.kind === "time" && ir.command.nodes.length <= 4
    && (!mode || mode.name === "append" || mode.name === "replace")) {
    return {kind: "function", id, tag, ticks: delay.value.ticks, replace: mode?.name !== "append"};
  }
}

export const scheduleRuntime = {
  assess(input: CapabilityInput): CapabilityResult {
    if (input.status === "invalid") return invalidCapability(input);
    const supported = readSchedule(input.ir) !== undefined;
    return {status: supported ? "runtime" : "unsupported", reason: supported ? "schedule runtime" : "unsupported schedule form", warnings: [], requiredContext: []};
  },
  execute(state: RuntimeState, ir: CommandIR): ExecutionResult {
    const command = readSchedule(ir);
    if (!command) return {success: false, error: "unsupported schedule form"};
    if (command.kind === "clear") {
      const count = state.schedule.clear({id: command.id, tag: false});
      return count ? {success: true, result: count} : {success: false, error: "no scheduled function"};
    }
    const {id, tag, ticks, replace} = command;
    const dueTick = state.schedule.tick + ticks;
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 2_147_483_647 || !Number.isSafeInteger(dueTick)) {
      return {success: false, error: "invalid schedule delay"};
    }
    if (!(tag ? state.functionTags : state.functions).has(id)) return {success: false, error: "unknown function"};
    state.schedule.schedule({id, tag}, dueTick, replace);
    return {success: true, result: dueTick % 2_147_483_647};
  },
};
