import { readFileSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { expect, it } from "vitest";
import {
  CommandParser, defaultExecutionContext, entityTarget, executeCommand, executeStorageCommand,
  nbt, nbtToPlain, resolvePosition, RuntimeState, selectEntities, toCommandIR,
  type Block, type CommandTreeNode, type ExecutionHost, type Position, type Rotation, type RuntimeEntity,
} from "@je2be/core";
import { paths } from "./paths.ts";
import { loadScenarios, readGolden } from "./scenario/load.ts";
import { javaBlockString } from "./scenario/normalize.ts";
import type { NormalizedState } from "./scenario/types.ts";

const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});

function parse(line: string) {
  const parsed = parser.parse(line);
  if (!parsed.ok) throw new Error(`${line}: ${parsed.error.message}`);
  return toCommandIR(line, parsed.nodes);
}

const overworld = "minecraft:overworld";
const nether = "minecraft:the_nether";
const air: Block = {kind: "block", id: "minecraft:air", tag: false, states: {}};

const chunkKey = (dimension: string, x: number, z: number) => `${dimension}:${Math.floor(x / 16)},${Math.floor(z / 16)}`;

class FakeHost implements ExecutionHost {
  readonly candidates: RuntimeEntity[];
  readonly blocks: Map<string, Block>;
  readonly forcedChunks: Set<string>;
  readonly state = new RuntimeState(this);
  private nextEntityId: number;

  constructor(candidates: RuntimeEntity[] = [], blocks = new Map<string, Block>(), forcedChunks = new Set<string>()) {
    this.candidates = candidates;
    this.blocks = blocks;
    this.forcedChunks = forcedChunks;
    this.nextEntityId = Math.max(0, ...candidates.map(entity => Number(entity.id.slice("entity-".length)))) + 1;
  }

  entities() { return this.candidates; }

  isLoaded(dimension: string, [x, , z]: Position) {
    const spawnArea = dimension === overworld && x >= 0 && x < 48 && z >= 0 && z < 48;
    return spawnArea || this.forcedChunks.has(chunkKey(dimension, x, z));
  }

  heightmapY(dimension: string, x: number, z: number, heightmap: Parameters<NonNullable<ExecutionHost["heightmapY"]>>[3]) {
    if (!this.isLoaded(dimension, [x, 0, z])) return;
    let height = -60; // Surface of the fixture's flat overworld.
    for (const [key, block] of this.blocks) {
      const [blockX, blockY, blockZ] = key.slice(dimension.length + 1).split(",").map(Number);
      if (!key.startsWith(`${dimension}:`) || x !== blockX || z !== blockZ || block.id === air.id) continue;
      if (heightmap === "motion_blocking_no_leaves" && block.id.endsWith("_leaves")) continue;
      if (heightmap === "ocean_floor" && block.id === "minecraft:water") continue;
      height = Math.max(height, blockY! + 1);
    }
    return height;
  }

  readBlock(dimension: string, position: Position) {
    if (!this.isLoaded(dimension, position)) return;
    return this.blocks.get(`${dimension}:${position}`) ?? air;
  }

  writeBlock(dimension: string, position: Position, block: Block) {
    const current = this.readBlock(dimension, position);
    if (!current) return {success: false, error: "block position not loaded"} as const;
    if (javaBlockString(current.id, current.states) === javaBlockString(block.id, block.states)) {
      return {success: false, error: "block unchanged"} as const;
    }
    this.blocks.set(`${dimension}:${position}`, block);
    return {success: true, result: 1} as const;
  }

  runNative(command: Parameters<NonNullable<ExecutionHost["runNative"]>>[0], context: Parameters<NonNullable<ExecutionHost["runNative"]>>[1], source: string) {
    if (command.name === "forceload" && command.nodes[0]?.name === "add") {
      const column = command.nodes[1]?.value;
      if (column?.kind !== "coordinates" || column.coordinates.length !== 2
        || column.coordinates.some(coordinate => coordinate.kind !== "absolute")) throw new Error("Invalid forceload fixture");
      const [x, z] = column.coordinates;
      this.forcedChunks.add(chunkKey(context.dimension, x!.value, z!.value));
      return {success: true, result: 1} as const;
    }
    if (command.name === "tp" || command.name === "kill") {
      const [target, position, rotation] = command.nodes;
      const selector = entityTarget(target?.value);
      const entities = selector && selectEntities(this, context, selector);
      if (!entities?.length) return {success: false, error: "no fixture targets"} as const;
      for (const entity of entities) {
        if (command.name === "kill") {
          this.candidates.splice(this.candidates.indexOf(entity), 1);
        } else {
          if (!position || position.value?.kind !== "coordinates" || rotation?.value?.kind !== "coordinates"
            || rotation.value.coordinates.some(coordinate => coordinate.kind !== "relative" || coordinate.value !== 0)) {
            throw new Error("Expected fixture teleport with source rotation");
          }
          entity.position = resolvePosition(position, source, context, this);
          entity.rotation = context.rotation;
        }
      }
      return {success: true, result: entities.length} as const;
    }
    if (command.name === "data" && command.nodes[6]?.name === "entity") {
      const [, , , , operation, mode, , target, path] = command.nodes;
      const selector = entityTarget(target?.value);
      const entities = selector && selectEntities(this, context, selector);
      if (operation?.name !== "set" || mode?.name !== "from" || entities?.length !== 1
        || path?.value?.kind !== "nbtPath" || path.value.path.length !== 1) throw new Error("Invalid entity storage fixture");
      const [field] = path.value.path;
      const [entity] = entities;
      const key = field?.kind === "key" && field.key;
      const value = key === "Pos" ? nbt.list("double", entity!.position.map(nbt.double))
        : key === "Rotation" ? nbt.list("float", entity!.rotation.map(angle => nbt.float(Math.fround(angle) || 0))) : undefined;
      if (!value) throw new Error("Unexpected entity storage fixture path");
      return executeStorageCommand(this.state.storage, {
        ...command, nodes: [...command.nodes.slice(0, 5), {...path, name: "value", value: {kind: "nbt", value}}],
      });
    }
    if (command.name !== "summon") return;
    const [type, position, dataNode] = command.nodes;
    if (type?.value?.kind !== "resource" || position?.value?.kind !== "coordinates") throw new Error("Invalid summon fixture");
    const id = type.value.id;
    if (id !== "minecraft:marker" && id !== "minecraft:armor_stand") throw new Error(`Unsupported fixture entity ${id}`);
    const data = dataNode?.value?.kind === "nbt" ? nbtToPlain(dataNode.value.value) as {Tags?: string[]; Rotation?: Rotation} : {};
    this.candidates.push({
      id: `entity-${this.nextEntityId++}`, type: id, tags: data.Tags ?? [], rotation: data.Rotation ?? [0, 0],
      position: resolvePosition(position, source, context), dimension: context.dimension,
      eyeHeight: id === "minecraft:armor_stand" ? 1.7775 : 0,
    });
    return {success: true, result: 1} as const;
  }
}

const scenarioIds = ["execute-context", "execute-anchor", "execute-dimension", "calls", "execute-order", "execute-order-reload", "execute-extra"];
const scenarios = loadScenarios();

const knownDiffs = {
  facing_feet_rotation: {axes: [0], reason: "Java uses an approximate atan2 for facing angles and stores float rotations."},
  facing_eyes_rotation: {axes: [0, 1], reason: "Java uses an approximate atan2 for facing angles and stores float rotations."},
};

it.each(scenarioIds)("%s matches the recorded Java state through CommandIR", id => {
  const scenario = scenarios.find(scenario => scenario.id === `datapack/${id}`)!;
  let host = new FakeHost();
  let state = host.state;
  const source = defaultExecutionContext();
  if (id === "execute-extra") source.position = [0, -60, 0]; // Java fixture's RCON source at spawn.
  const run = (line: string) => executeCommand(state, parse(line), undefined, source);
  const loadDatapack = () => {
    for (const [name, lines] of Object.entries(scenario.datapack?.functions ?? {})) state.functions.set(name, lines.map(parse));
    for (const [name, tag] of Object.entries(scenario.datapack?.functionTags ?? {})) {
      state.functionTags.set(name, tag.values.map(value => typeof value === "string" ? value : value.id));
    }
  };
  for (const line of scenario.setup) expect(run(line), line).toMatchObject({success: true});
  loadDatapack();
  for (const [index, action] of scenario.actions.entries()) {
    if ("restart" in action) {
      // The saved entity list carries the traversal order and IDs used by the scoreboard.
      const world = {
        entities: host.candidates,
        blocks: host.blocks,
        forcedChunks: host.forcedChunks,
        scores: state.scores.objectives,
        storage: state.storage.values,
      };
      const saved = serialize(world);
      const restored = deserialize(saved) as typeof world;
      host = new FakeHost(restored.entities, restored.blocks, restored.forcedChunks);
      state = host.state;
      for (const [name, scores] of restored.scores) state.scores.objectives.set(name, scores);
      for (const [id, nbt] of restored.storage) state.storage.values.set(id, nbt);
      loadDatapack();
      continue;
    }
    if (!("run" in action)) throw new Error("Expected command action");
    const expectedError = id === "calls" ? [undefined, "return fail", undefined, "condition failed"][index]
      : id === "execute-extra" && [11, 19, 20, 22].includes(index) ? "condition failed" : undefined;
    expect(run(action.run), action.run).toMatchObject(expectedError ? {success: false, error: expectedError} : {success: true});
  }

  if (id === "execute-dimension") expect(host.forcedChunks.has(chunkKey(nether, 8, 8))).toBe(true);

  const actual: NormalizedState = {};
  const {observe} = scenario;
  if (observe.scores) actual.scores = Object.fromEntries(observe.scores.map(key => [key, Object.fromEntries(state.scores.objectives.get(key) ?? [])]));
  if (observe.storage) actual.storage = Object.fromEntries(observe.storage.map(key => [key, nbtToPlain(state.storage.get(key))]));
  if (observe.blocks) {
    actual.blocks = {};
    for (const {from, to = from} of observe.blocks) {
      for (let x = from[0]; x <= to[0]; x++) {
        for (let y = from[1]; y <= to[1]; y++) {
          for (let z = from[2]; z <= to[2]; z++) {
          const block = host.readBlock(overworld, [x, y, z])!;
            actual.blocks[`${x},${y},${z}`] = javaBlockString(block.id, block.states);
          }
        }
      }
    }
  }
  const expected = readGolden(scenario)!.state;
  if (id === "execute-extra") {
    const readValues = (state: NormalizedState) => (state.storage?.["probe:result"] as {values: Record<string, number[]>}).values;
    const actualValues = readValues(actual), expectedValues = readValues(expected);
    for (const [key, {axes, reason}] of Object.entries(knownDiffs)) {
      for (const axis of axes) {
        const value = actualValues[key]![axis]!, golden = expectedValues[key]![axis]!;
        expect(Math.abs(value - golden), `${key}[${axis}]: ${reason}`).toBeLessThan(0.0001);
        actualValues[key]![axis] = golden;
      }
    }
  }
  expect(actual).toEqual(expected);
});

it("scales relative block coordinates in both directions when changing dimensions", () => {
  const host = new FakeHost([], new Map(), new Set([chunkKey(nether, 10, -3), chunkKey(overworld, 80, -24)]));
  const {state} = host;
  const context = {...defaultExecutionContext(), position: [80, 70, -24] as Position};
  const toNether = parse("execute in minecraft:the_nether run setblock ~ ~ ~ minecraft:gold_block");
  const toOverworld = parse("execute in minecraft:overworld run setblock ~ ~ ~ minecraft:diamond_block");
  expect(executeCommand(state, toNether, undefined, context).success).toBe(true);
  expect(executeCommand(state, toOverworld, undefined, {...context, position: [10, 70, -3], dimension: "nether"}).success).toBe(true);
  expect(host.readBlock(nether, [10, 70, -3])?.id).toBe("minecraft:gold_block");
  expect(host.readBlock(overworld, [80, 70, -24])?.id).toBe("minecraft:diamond_block");
});

it("distinguishes a matching empty masked region from a failed condition", () => {
  const {state} = new FakeHost();
  const run = (line: string) => executeCommand(state, parse(line));
  const region = "16 70 16 16 70 16 17 70 16";
  expect(run("scoreboard objectives add probe dummy").success).toBe(true);
  expect(run(`execute store success score #empty probe if blocks ${region} masked`)).toEqual({success: true, result: 0});
  expect(state.scores.get("#empty", "probe")).toBe(1);
  expect(run(`execute store result score #skipped probe unless blocks ${region} masked run scoreboard players set #skipped probe 42`))
    .toEqual({success: false, error: "condition failed"});
  expect(state.scores.get("#skipped", "probe")).toBeUndefined();
  expect(run("execute unless blocks 1000000 0 1000000 1000000 0 1000000 16 0 16 all"))
    .toEqual({success: false, error: "block position not loaded"});
});

it("resets the eyes anchor after resolving positioned and validates before executing a function condition", () => {
  const host = new FakeHost();
  const {state} = host;
  const run = (line: string) => executeCommand(state, parse(line));
  expect(run("summon armor_stand 8 -60 8").success).toBe(true);
  expect(run("execute as @e[type=armor_stand] at @s anchored eyes positioned ^ ^ ^1 run setblock ^ ^ ^1 minecraft:stone").success).toBe(true);
  expect(host.readBlock(overworld, [8, -59, 10])?.id).toBe("minecraft:stone");
  state.functions.set("test:condition", [parse("data modify storage test:probe touched set value 1"), parse("return 1")]);
  expect(run("execute if function test:condition if biome ~ ~ ~ plains run setblock ~ ~ ~ minecraft:stone")).toEqual({success: false, error: "unsupported execute step"});
  expect(state.storage.values.size).toBe(0);
});
