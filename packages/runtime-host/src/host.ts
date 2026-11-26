import { BlockPermutation, GameMode, ScoreboardIdentityType, world, type Player, type Vector3 } from "@minecraft/server";
import { executeCommand, RuntimeState } from "../../core/src/runtime/command.ts";
import type { CommandIR } from "../../core/src/command/parser.ts";
import { dimensionId, type ExecutionContext, type ExecutionHost, type RuntimeEntity } from "../../core/src/runtime/context.ts";
import type { CommandResult } from "../../core/src/runtime/index.ts";

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
  return runNative(() => world.getDimension(dimension), command, completion);
}
function runNative(source: () => { runCommand(command: string): {successCount: number} }, command: string, completion: "synchronous" | "deferred") {
  return attempt(() => {
    const result = source().runCommand(command);
    return completion === "synchronous" ? { status: "known" as const, successCount: result.successCount } : { status: "unknown" as const };
  });
}

export type NativeCommandResolver = (source: string) =>
  {command: string; completion: "synchronous" | "deferred"} | undefined;

export const bedrockDimension = (id: string) => dimensionId(id) === "minecraft:the_nether" ? "nether" : dimensionId(id).replace(/^minecraft:/, "");
const dimensions = ["overworld", "nether", "the_end"];
const gameModes: Record<GameMode, NonNullable<RuntimeEntity["gamemode"]>> = {
  [GameMode.Survival]: "survival",
  [GameMode.Creative]: "creative",
  [GameMode.Adventure]: "adventure",
  [GameMode.Spectator]: "spectator",
};

/** BE command coordinates use decimal tokens. Integer X/Z tokens can snap to block centers. */
function nativeNumber(value: number): string {
  const [coefficient, exponent] = String(value).split("e") as [string, string?];
  if (exponent === undefined) return Number.isInteger(value) ? coefficient + ".0" : coefficient;
  const [integer, fraction = ""] = coefficient.replace(/^-/, "").split(".") as [string, string?];
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  const sign = value < 0 ? "-" : "";
  if (point <= 0) return sign + "0." + "0".repeat(-point) + digits;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length) + ".0";
  return sign + digits.slice(0, point) + "." + digits.slice(point);
}

function executeNative(context: ExecutionContext, native: NonNullable<ReturnType<NativeCommandResolver>>): CommandResult {
  const dimension = bedrockDimension(context.dimension);
  const source = () => {
    if (context.executor === undefined) return world.getDimension(dimension);
    const executor = world.getEntity(context.executor);
    if (!executor?.isValid) throw Error(`executor ${context.executor} is unavailable`);
    return executor;
  };
  const position = context.position.map(nativeNumber).join(" ");
  const rotation = context.rotation.map(nativeNumber).join(" ");
  const command = `execute in ${dimension} positioned ${position} rotated ${rotation} anchored ${context.anchor} run ${native.command}`;
  const result = runNative(source, command, native.completion);
  if (!result.ok) return {success: false, error: result.error.message};
  if (result.value.status === "unknown") return result.value;
  return result.value.successCount > 0
    ? {success: true, result: result.value.successCount}
    : {success: false, error: "native command failed"};
}

function executionHost(runNative: NonNullable<ExecutionHost["runNative"]>): ExecutionHost {
  return {
    entities: () => dimensions.flatMap(dimension => world.getDimension(dimension).getEntities().map(entity => {
      const {x, y, z} = entity.location;
      const {x: pitch, y: yaw} = entity.getRotation();
      const player = entity.typeId === "minecraft:player" ? entity as Player : undefined;
      return {id: entity.id, type: entity.typeId, tags: entity.getTags(),
        position: [x, y, z], rotation: [yaw, pitch], dimension: dimensionId(dimension),
        eyeHeight: entity.getHeadLocation().y - y, ...(player && {name: player.name, gamemode: gameModes[player.getGameMode()]})};
    })),
    // Core block conditions need Java IDs and states, including block entity data.
    readBlock: () => undefined,
    runNative,
  };
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
  private restricted = false;
  private pendingScores: Scores | undefined;
  private chainCommands: ReadonlyMap<string, string> | undefined;
  private pendingNative: { before: Scores; run: () => CommandResult; source: string }[] = [];
  constructor(state = new RuntimeState(), resolveNative?: NativeCommandResolver) {
    this.state = state;
    state.host ??= executionHost((_command, context, source) => {
      if (this.chainCommands) {
        const command = this.chainCommands.get(source);
        if (command === undefined) return undefined;
        return this.deferChainCommand(source, command, context);
      }
      const native = resolveNative?.(source);
      if (native) return this.restricted ? {status: "unknown"} : executeNative(context, native);
    });
  }
  get isConsistent(): boolean { return this.consistent; }
  /** Capture changes made by native commands to managed fake-player scores. */
  syncScores(): void {
    if (!this.consistent) throw Error("inconsistent session");
    try {
      if (this.pendingScores) {
        let before = this.pendingScores;
        const flush = (after: Scores) => {
          const projection = project(before, after);
          if (!projection.ok) throw Error(`score projection failed for ${projection.target}: ${projection.error.message}`);
          before = after;
        };
        for (const pending of this.pendingNative) {
          flush(pending.before);
          const result = pending.run();
          if (!("status" in result) && !result.success) console.warn(`[je2be] deferred ${pending.source}: ${result.error}`);
        }
        this.pendingNative = [];
        flush(this.state.scores.objectives);
        this.pendingScores = undefined;
      }
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

  deferChainCommand(source: string, command: string, context: ExecutionContext): CommandResult {
    if (!this.consistent) return {success: false, error: "inconsistent session"};
    if (this.unknownNative) return {status: "unknown"};
    this.beginRestricted();
    this.pendingNative.push({before: snapshot(this.state), source, run: () => executeNative(context, {command, completion: "synchronous"})});
    return {status: "unknown"};
  }

  private beginRestricted(): void {
    // Between callbacks in one tick, core commands read the unprojected scores.
    if (this.pendingScores) return;
    this.syncScores();
    this.pendingScores = snapshot(this.state);
  }

  /** Evaluate during a custom command, leaving score projection for the next writable tick. */
  executeRestricted(ir: CommandIR, context: ExecutionContext, chainCommands?: ReadonlyMap<string, string>): CommandResult {
    if (!this.consistent) return {success: false, error: "inconsistent session"};
    if (this.unknownNative) return {status: "unknown"};
    this.beginRestricted();
    this.restricted = true;
    this.chainCommands = chainCommands;
    try { return executeCommand(this.state, ir, undefined, context, undefined, chainCommands !== undefined); }
    finally { this.restricted = false; this.chainCommands = undefined; }
  }
  runNative(dimension: string, command: string, completion: "synchronous" | "deferred") {
    if (!this.consistent) return { status: "inconsistent" as const };
    if (this.unknownNative) return { status: "unknown-native" as const };
    const result = nativeCommand(dimension, command, completion);
    if (result.ok && result.value.status === "unknown") this.unknownNative = true;
    return { status: "executed" as const, result };
  }
  execute(ir: CommandIR, context?: ExecutionContext) {
    if (!this.consistent) return { status: "inconsistent" as const };
    if (this.unknownNative) return { status: "unknown-native" as const };
    try { this.syncScores(); } catch (error) { return { status: "inconsistent" as const, error: String(error) }; }
    let before = snapshot(this.state);
    let projection: Projection = {ok: true};
    const flush = () => {
      if (!projection.ok) return projection;
      const after = snapshot(this.state);
      projection = project(before, after);
      if (projection.ok) before = after;
      else this.consistent = false;
      return projection;
    };
    const core = executeCommand(this.state, ir, undefined, context, () =>
      flush().ok ? undefined : {success: false, error: "score projection failed before native command"});
    projection = flush();
    if ("status" in core) this.unknownNative = true;
    return { status: "executed" as const, core, projection };
  }
}
