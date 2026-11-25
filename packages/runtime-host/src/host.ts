import { BlockPermutation, ScoreboardIdentityType, world, type Vector3 } from "@minecraft/server";
import { executeCommand, RuntimeState } from "../../core/src/runtime/command.ts";
import type { CommandIR } from "../../core/src/command/parser.ts";

export type HostError = { kind: "unloaded" | "out-of-bounds" | "absent" | "invalid" | "exception" | "unsupported"; message: string };
export type HostResult<T> = { ok: true; value: T } | { ok: false; error: HostError };
const ok = <T>(value: T): HostResult<T> => ({ ok: true, value });
const fail = (kind: HostError["kind"], message: string): HostResult<never> => ({ ok: false, error: { kind, message } });
function attempt<T>(fn: () => T): HostResult<T> {
  try { return ok(fn()); } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const kind = name.includes("UnloadedChunk") ? "unloaded" : name.includes("OutOfWorldBoundaries") ? "out-of-bounds" : name.includes("InvalidEntity") ? "invalid" : "exception";
    return fail(kind, String(error));
  }
}
export type Property = boolean | number | string | Vector3;
export type BlockState = { type: string; states: Record<string, boolean | number | string> };

/** Candidate enumeration only covers loaded entities; consumers must not treat it as complete. */
export function candidates(dimension: string): HostResult<{ ids: string[]; complete: false }> {
  return attempt(() => ({ ids: world.getDimension(dimension).getEntities().map(entity => entity.id), complete: false as const }));
}
export function entity(id: string): HostResult<{ id: string; type: string; location: Vector3 }> {
  const result = attempt(() => {
    const found = world.getEntity(id);
    return found ? { id: found.id, type: found.typeId, location: found.location } : undefined;
  });
  return result.ok && !result.value ? fail("absent", `entity ${id} not found`) : result as HostResult<{ id: string; type: string; location: Vector3 }>;
}
export function readBlock(dimension: string, position: Vector3): HostResult<BlockState> {
  const result = attempt(() => {
    const block = world.getDimension(dimension).getBlock(position);
    return block ? { type: block.typeId, states: block.permutation.getAllStates() } : undefined;
  });
  return result.ok && !result.value ? fail("unloaded", "block is not loaded") : result as HostResult<BlockState>;
}
export function writeBlock(dimension: string, position: Vector3, state: BlockState): HostResult<void> {
  const result = attempt(() => {
    const block = world.getDimension(dimension).getBlock(position);
    if (!block) return false;
    block.setPermutation(BlockPermutation.resolve(state.type, state.states));
    return true;
  });
  return !result.ok ? result : result.value ? ok(undefined) : fail("unloaded", "block is not loaded");
}
/** A caller must explicitly identify commands whose effect can be observed synchronously. */
export function nativeCommand(dimension: string, command: string, completion: "synchronous" | "deferred"): HostResult<{ status: "known"; successCount: number } | { status: "unknown" }> {
  return attempt(() => {
    const result = world.getDimension(dimension).runCommand(command);
    return completion === "synchronous" ? { status: "known" as const, successCount: result.successCount } : { status: "unknown" as const };
  });
}
export function readProperty(key: string): HostResult<Property | undefined> { return attempt(() => world.getDynamicProperty(key)); }
export function writeProperty(key: string, value?: Property): HostResult<void> { return attempt(() => world.setDynamicProperty(key, value)); }

type Scores = Map<string, Map<string, number>>;
const snapshot = (state: RuntimeState): Scores => new Map([...state.scores.objectives].map(([id, scores]) => [id, new Map(scores)]));
const ordered = (values: Iterable<string>): string[] => [...values].sort();
type Projection = { ok: true } | { ok: false; target: string; error: HostError };
function project(before: Scores, after: Scores): Projection {
  const perform = (target: string, action: () => void): Projection => {
    const result = attempt(action);
    return result.ok ? { ok: true } : { ok: false, target, error: result.error };
  };
  for (const id of ordered(before.keys())) if (!after.has(id)) {
    const result = perform(id, () => { if (!world.scoreboard.removeObjective(id)) throw Error("objective missing"); });
    if (!result.ok) return result;
  }
  for (const id of ordered(after.keys())) {
    const scores = after.get(id)!;
    if (!before.has(id)) {
      const result = perform(id, () => { world.scoreboard.addObjective(id, id); });
      if (!result.ok) return result;
    }
    const previous = before.get(id) ?? new Map<string, number>();
    for (const holder of ordered(previous.keys())) if (!scores.has(holder)) {
      const result = perform(`${id}/${holder}`, () => { if (!world.scoreboard.getObjective(id)?.removeParticipant(holder)) throw Error("score missing"); });
      if (!result.ok) return result;
    }
    for (const holder of ordered(scores.keys())) if (previous.get(holder) !== scores.get(holder)) {
      const result = perform(`${id}/${holder}`, () => { const objective = world.scoreboard.getObjective(id); if (!objective) throw Error("objective missing"); objective.setScore(holder, scores.get(holder)!); });
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}
/** One instance tracks whether a failed projection makes subsequent execution unsafe. */
export class RuntimeSession {
  readonly state: RuntimeState;
  private consistent = true;
  private unknownNative = false;
  constructor(state = new RuntimeState()) { this.state = state; }
  get isConsistent(): boolean { return this.consistent; }
  /** Capture changes made by native commands to managed fake-player scores. */
  syncScores(): void {
    if (!this.consistent) throw Error("inconsistent session");
    try {
      for (const [id, scores] of this.state.scores.objectives) {
        const objective = world.scoreboard.getObjective(id);
        if (!objective) throw Error(`managed objective missing: ${id}`);
        const current = new Map<string, number>();
        for (const participant of objective.getParticipants()) if (participant.type === ScoreboardIdentityType.FakePlayer) {
          const value = objective.getScore(participant);
          if (value !== undefined) current.set(participant.displayName, value);
        }
        scores.clear();
        for (const [holder, value] of current) scores.set(holder, value);
      }
    } catch (error) { this.consistent = false; throw error; }
  }
  halt(): void { this.consistent = false; }
  runNative(dimension: string, command: string, completion: "synchronous" | "deferred") {
    if (!this.consistent) return { status: "inconsistent" as const };
    if (this.unknownNative) return { status: "unknown-native" as const };
    const result = nativeCommand(dimension, command, completion);
    if (result.ok && result.value.status === "unknown") this.unknownNative = true;
    return { status: "executed" as const, result };
  }
  execute(ir: CommandIR) {
    if (!this.consistent) return { status: "inconsistent" as const };
    if (this.unknownNative) return { status: "unknown-native" as const };
    try { this.syncScores(); } catch (error) { return { status: "inconsistent" as const, error: String(error) }; }
    const before = snapshot(this.state);
    const core = executeCommand(this.state, ir);
    const projection = project(before, snapshot(this.state));
    if (!projection.ok) this.consistent = false;
    return { status: "executed" as const, core, projection };
  }
}
