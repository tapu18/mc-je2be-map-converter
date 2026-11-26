import type { ArgumentValue, Coordinate, EntitySelector, Range } from "../command/arguments.ts";
import type { CommandIR, ParsedNode } from "../command/parser.ts";
import type { ExecutionResult } from "./index.ts";
import type { Scoreboard } from "./scores.ts";

export type Position = [number, number, number];
export type Rotation = [number, number]; // yaw, pitch

/** Execution source carried independently through function and return frames. */
export interface ExecutionContext {
  executor?: string;
  position: Position;
  rotation: Rotation;
  anchor: "feet" | "eyes";
  dimension: string;
}

export interface RuntimeEntity {
  /** Stable ID used for @s and as the score holder for non-player entities. */
  id: string;
  name?: string;
  type: string;
  tags: readonly string[];
  /** Absent for an entity without a team. */
  team?: string;
  /** Supplied for player candidates when the host knows their game mode. */
  gamemode?: "survival" | "creative" | "adventure" | "spectator";
  position: Position;
  rotation: Rotation;
  dimension: string;
  eyeHeight: number;
}

export type Block = Extract<ArgumentValue, {kind: "block"}>;
export type Heightmap = "world_surface" | "motion_blocking" | "motion_blocking_no_leaves" | "ocean_floor";

/** Host IDs are namespaced Java IDs. The Bedrock boundary maps the_nether to nether. */
export interface ExecutionHost {
  /** Enumerate entities in the world's current selector traversal order (e.g. @e[sort=arbitrary]). */
  entities(): readonly RuntimeEntity[];
  /** Return the full block state, including air in loaded positions and block entity data without coordinates. */
  readBlock(dimension: string, position: Position): Block | undefined;
  writeBlock(dimension: string, position: Position, block: Block): ExecutionResult;
  /** Report whether the chunk has reached the loaded state required by Java's execute if loaded. */
  isLoaded?(dimension: string, position: Position): boolean;
  /** Return the first Y above the heightmap surface, or undefined for an unloaded column. */
  heightmapY?(dimension: string, x: number, z: number, heightmap: Heightmap): number | undefined;
  /** Order a mutable candidate list using the host's random source. */
  shuffle?(entities: RuntimeEntity[]): void;
  runNative?(command: NonNullable<CommandIR["command"]>, context: ExecutionContext, source: string): ExecutionResult | undefined;
}

export function defaultExecutionContext(): ExecutionContext {
  return {position: [0, 0, 0], rotation: [0, 0], anchor: "feet", dimension: "minecraft:overworld"};
}

export function dimensionId(id: string): string {
  return id === "nether" || id === "minecraft:nether" ? "minecraft:the_nether" : id.includes(":") ? id : `minecraft:${id}`;
}

export function dimensionScale(id: string): number {
  return dimensionId(id) === "minecraft:the_nether" ? 8 : 1;
}

export function anchoredPosition(context: ExecutionContext, host?: ExecutionHost): Position {
  const [x, y, z] = context.position;
  const executor = context.anchor === "eyes" && context.executor !== undefined
    ? host?.entities().find(entity => entity.id === context.executor) : undefined;
  return [x, y + (executor?.eyeHeight ?? 0), z];
}

const radians = Math.PI / 180;

export function resolvePosition(node: ParsedNode, source: string, context: ExecutionContext, host?: ExecutionHost): Position {
  const coordinates = (node.value as Extract<ArgumentValue, {kind: "coordinates"}>).coordinates;
  const [x, y, z] = coordinates as [Coordinate, Coordinate, Coordinate];
  if (x.kind === "local") {
    const [yaw, pitch] = context.rotation.map(angle => angle * radians) as Rotation;
    const origin = anchoredPosition(context, host);
    const forward = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const up = [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)];
    const left = [Math.cos(yaw), 0, Math.sin(yaw)];
    return origin.map((value, i) => value + forward[i]! * z.value + up[i]! * y.value + left[i]! * x.value) as Position;
  }
  // Java centers absolute vec3 X/Z tokens that have no decimal point.
  const tokens = source.slice(node.start, node.end).split(" ");
  return coordinates.map((coordinate, i) => coordinate.kind === "relative"
    ? context.position[i]! + coordinate.value
    : coordinate.value + (node.parser === "minecraft:vec3" && i !== 1 && /^-?\d+$/.test(tokens[i] ?? "") ? 0.5 : 0)) as Position;
}

export function facingRotation(from: Position, to: Position): Rotation {
  const [x, y, z] = to.map((value, i) => value - from[i]!) as Position;
  const yaw = Math.atan2(z, x) / radians - 90;
  return [((yaw + 180) % 360 + 360) % 360 - 180, -Math.atan2(y, Math.hypot(x, z)) / radians];
}

export function inRange(value: number, range: Range): boolean {
  return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
}

type EntityTarget = Extract<ArgumentValue, {kind: "selector" | "name"}>;
const positionKeys = ["x", "y", "z"] as const;

function supportsSelector(selector: EntitySelector): boolean {
  return selector.arguments.every(({key, value}) => {
    if (["x", "y", "z", "limit"].includes(key)) return value.kind === "number";
    if (key === "type") return value.kind === "resource" && !value.tag;
    if (key === "tag" || key === "name" || key === "team") return value.kind === "string";
    if (key === "gamemode") return value.kind === "string" && ["survival", "creative", "adventure", "spectator"].includes(value.value);
    if (key === "scores") return value.kind === "scores";
    if (key === "sort") return value.kind === "string" && ["arbitrary", "nearest", "furthest", "random"].includes(value.value);
    return key === "distance" && value.kind === "range";
  });
}

export function entityTarget(value?: ArgumentValue): EntityTarget | undefined {
  return value?.kind === "name" || (value?.kind === "selector" && supportsSelector(value.selector)) ? value : undefined;
}

/** Undefined indicates a selection requiring unavailable host capabilities or scoreboard state. */
export function selectEntities(host: ExecutionHost | undefined, context: ExecutionContext, target: EntityTarget, scores?: Scoreboard): RuntimeEntity[] | undefined {
  const entities = host?.entities() ?? [];
  if (target.kind === "name") return entities.filter(entity => entity.id === target.value || (entity.type === "minecraft:player" && entity.name === target.value));
  const {variable, arguments: args} = target.selector;
  if (!scores && args.some(({value}) => value.kind === "scores" && Object.keys(value.scores).length > 0)) return undefined;
  const playersOnly = ["a", "p", "r"].includes(variable);
  const origin = [...context.position] as Position;
  let worldLimited = false;
  let sort = variable === "p" || variable === "n" ? "nearest" : variable === "r" ? "random" : "arbitrary";
  let limit = ["p", "r", "s", "n"].includes(variable) ? 1 : Infinity;
  for (const {key, value} of args) {
    if (key === "sort" && value.kind === "string") sort = value.value;
    if (key === "limit" && value.kind === "number") limit = value.value;
    if (key === "distance") worldLimited = true;
    for (const [axis, name] of positionKeys.entries()) {
      if (key === name && value.kind === "number") { origin[axis] = value.value; worldLimited = true; }
    }
  }

  const distanceSquared = (entity: RuntimeEntity) => entity.position.reduce((sum, value, i) => sum + (value - origin[i]!) ** 2, 0);
  const found = entities.filter(entity => {
    if (variable === "s" && entity.id !== context.executor) return false;
    if (playersOnly && entity.type !== "minecraft:player") return false;
    if (variable !== "s" && worldLimited && dimensionId(entity.dimension) !== context.dimension) return false;
    return args.every(({key, value, negated}) => {
      if (key === "type" && value.kind === "resource") return (entity.type === value.id) !== negated;
      if (key === "tag" && value.kind === "string") return (value.value ? entity.tags.includes(value.value) : entity.tags.length === 0) !== negated;
      if (key === "name" && value.kind === "string") return (entity.name === value.value) !== negated;
      if (key === "team" && value.kind === "string") return ((entity.team ?? "") === value.value) !== negated;
      if (key === "gamemode" && value.kind === "string") {
        return entity.type === "minecraft:player" && entity.gamemode !== undefined && (entity.gamemode === value.value) !== negated;
      }
      if (key === "scores" && value.kind === "scores") {
        const holder = scoreHolder(entity);
        return Object.entries(value.scores).every(([objective, range]) => {
          const score = scores?.get(holder, objective);
          return score !== undefined && inRange(score, range);
        });
      }
      if (key === "distance" && value.kind === "range") return inRange(Math.sqrt(distanceSquared(entity)), value.range);
      return true;
    });
  });
  // Arbitrary order and equal-distance ties retain the host's traversal order.
  // Apply the limit to the ordered candidates, including after a host shuffle.
  if (sort === "nearest" || sort === "furthest") {
    const sign = sort === "nearest" ? 1 : -1;
    found.sort((a, b) => sign * (distanceSquared(a) - distanceSquared(b)));
  } else if (sort === "random" && found.length > 1) {
    if (!host?.shuffle) return undefined;
    host.shuffle(found);
  }
  return found.slice(0, limit);
}

export function scoreHolder(entity: RuntimeEntity): string {
  return entity.type === "minecraft:player" ? entity.name ?? entity.id : entity.id;
}
