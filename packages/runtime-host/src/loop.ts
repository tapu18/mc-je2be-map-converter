import type { CommandIR } from "../../core/src/command/parser.ts";
import { scheduledFunctionCalls } from "../../core/src/runtime/command.ts";
import type { RuntimeSession } from "./host.ts";

export interface Scheduler {
  runInterval(callback: () => void, ticks: number): number;
  clearRun(id: number): void;
}

/**
 * Run a command through the session and throw when the runtime must stop: an inconsistent projection, an unknown
 * native result here, an unsupported construct, or an exceeded budget. A line without a BE command is an ordinary
 * failure when the session fails undelegated lines (#353), so it does not reach here.
 */
export function executeOrThrow(runtime: RuntimeSession, ir: CommandIR): void {
  const result = runtime.execute(ir);
  if (result.status !== "executed" || !result.projection.ok || "status" in result.core) {
    throw Error(`${ir.source}: ${JSON.stringify(result)}`);
  }
  if (!result.core.success && (result.core.error.startsWith("unsupported") || result.core.error.endsWith("budget exceeded"))) {
    throw Error(`${ir.source}: ${result.core.error}`);
  }
}

/** Run `function #<id>` when the tag exists. */
export function runFunctionTag(runtime: RuntimeSession, id: string): void {
  if (!runtime.state.functionTags.has(id)) return;
  const source = `function #${id}`;
  executeOrThrow(runtime, {source, context: [], command: {name: "function", nodes: [
    {kind: "argument", name: "name", start: 9, end: source.length, value: {kind: "resource", id, tag: true}},
  ]}});
}

/** Run one game tick of the runtime: pending scores, queued chains, schedule, then the tick tag. */
export function runTick(runtime: RuntimeSession): void {
  // Project pending launcher scores, then run chains moved after this tick's command blocks
  // (#93 decision 2), before schedule and the tick tag.
  runtime.syncScores();
  runtime.runQueuedChains();
  if (runtime.state.functions.size) for (const {ir} of scheduledFunctionCalls(runtime.state)) executeOrThrow(runtime, ir);
  runFunctionTag(runtime, "minecraft:tick");
}

/** Run every tick until a tick throws, then halt the session and stop the interval. */
export function startTicking(runtime: RuntimeSession, commit: () => void, scheduler: Scheduler, warn: (message: string) => void): number {
  const interval = scheduler.runInterval(() => {
    try {
      runTick(runtime);
      commit();
    } catch (error) {
      runtime.halt();
      scheduler.clearRun(interval);
      warn("[je2be] tick stopped: " + error);
    }
  }, 1);
  return interval;
}
