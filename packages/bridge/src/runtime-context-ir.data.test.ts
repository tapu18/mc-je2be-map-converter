import { readFileSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { expect, it } from "vitest";
import {
  CommandParser, defaultExecutionContext, executeCommand, nbtToPlain, resolvePosition, RuntimeState, toCommandIR,
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

class FakeHost implements ExecutionHost {
  readonly candidates: RuntimeEntity[];
  readonly blocks: Map<string, Block>;

  constructor(candidates: RuntimeEntity[] = [], blocks = new Map<string, Block>()) {
    this.candidates = candidates;
    this.blocks = blocks;
  }

  entities() { return this.candidates; }

  readBlock(dimension: string, position: Position) {
    return this.blocks.get(`${dimension}:${position}`) ?? air;
  }

  writeBlock(dimension: string, position: Position, block: Block) {
    const current = this.readBlock(dimension, position);
    if (javaBlockString(current.id, current.states) === javaBlockString(block.id, block.states)) {
      return {success: false, error: "block unchanged"} as const;
    }
    this.blocks.set(`${dimension}:${position}`, block);
    return {success: true, result: 1} as const;
  }

  runNative(command: Parameters<NonNullable<ExecutionHost["runNative"]>>[0], context: Parameters<NonNullable<ExecutionHost["runNative"]>>[1], source: string) {
    // The fake world is always loaded. Verify that the fixture's request reaches the Nether.
    if (command.name === "forceload" && command.nodes[0]?.name === "add") {
      expect(context.dimension).toBe(nether);
      return {success: true, result: 1} as const;
    }
    if (command.name !== "summon") return;
    const [type, position, nbt] = command.nodes;
    if (type?.value?.kind !== "resource" || position?.value?.kind !== "coordinates") throw new Error("Invalid summon fixture");
    const id = type.value.id;
    if (id !== "minecraft:marker" && id !== "minecraft:armor_stand") throw new Error(`Unsupported fixture entity ${id}`);
    const data = nbt?.value?.kind === "nbt" ? nbtToPlain(nbt.value.value) as {Tags?: string[]; Rotation?: Rotation} : {};
    this.candidates.push({
      id: `entity-${this.candidates.length + 1}`, type: id, tags: data.Tags ?? [], rotation: data.Rotation ?? [0, 0],
      position: resolvePosition(position, source, context), dimension: context.dimension,
      eyeHeight: id === "minecraft:armor_stand" ? 1.7775 : 0,
    });
    return {success: true, result: 1} as const;
  }
}

const scenarioIds = ["execute-context", "execute-anchor", "execute-dimension", "calls", "execute-order", "execute-order-reload"];
const scenarios = loadScenarios();

it.each(scenarioIds)("%s matches the recorded Java state through CommandIR", id => {
  const scenario = scenarios.find(scenario => scenario.id === `datapack/${id}`)!;
  let host = new FakeHost();
  let state = new RuntimeState(host);
  const run = (line: string) => executeCommand(state, parse(line));
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
        scores: state.scores.objectives,
        storage: state.storage.values,
      };
      const saved = serialize(world);
      const restored = deserialize(saved) as typeof world;
      host = new FakeHost(restored.entities, restored.blocks);
      state = new RuntimeState(host);
      for (const [name, scores] of restored.scores) state.scores.objectives.set(name, scores);
      for (const [id, nbt] of restored.storage) state.storage.values.set(id, nbt);
      loadDatapack();
      continue;
    }
    if (!("run" in action)) throw new Error("Expected command action");
    const expectedError = id === "calls" ? [undefined, "return fail", undefined, "condition failed"][index] : undefined;
    expect(run(action.run), action.run).toMatchObject(expectedError ? {success: false, error: expectedError} : {success: true});
  }

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
            const block = host.readBlock(overworld, [x, y, z]);
            actual.blocks[`${x},${y},${z}`] = javaBlockString(block.id, block.states);
          }
        }
      }
    }
  }
  expect(actual).toEqual(readGolden(scenario)!.state);
});

it("scales relative block coordinates in both directions when changing dimensions", () => {
  const host = new FakeHost();
  const state = new RuntimeState(host);
  const context = {...defaultExecutionContext(), position: [80, 70, -24] as Position};
  const toNether = parse("execute in minecraft:the_nether run setblock ~ ~ ~ minecraft:gold_block");
  const toOverworld = parse("execute in minecraft:overworld run setblock ~ ~ ~ minecraft:diamond_block");
  expect(executeCommand(state, toNether, undefined, context).success).toBe(true);
  expect(executeCommand(state, toOverworld, undefined, {...context, position: [10, 70, -3], dimension: "nether"}).success).toBe(true);
  expect(host.readBlock(nether, [10, 70, -3]).id).toBe("minecraft:gold_block");
  expect(host.readBlock(overworld, [80, 70, -24]).id).toBe("minecraft:diamond_block");
});

it("resets the eyes anchor after resolving positioned and validates before executing a function condition", () => {
  const host = new FakeHost();
  const state = new RuntimeState(host);
  const run = (line: string) => executeCommand(state, parse(line));
  expect(run("summon armor_stand 8 -60 8").success).toBe(true);
  expect(run("execute as @e[type=armor_stand] at @s anchored eyes positioned ^ ^ ^1 run setblock ^ ^ ^1 minecraft:stone").success).toBe(true);
  expect(host.readBlock(overworld, [8, -59, 10]).id).toBe("minecraft:stone");
  state.functions.set("test:condition", [parse("data modify storage test:probe touched set value 1"), parse("return 1")]);
  expect(run("execute if function test:condition align x run setblock ~ ~ ~ minecraft:stone")).toEqual({success: false, error: "unsupported execute step"});
  expect(state.storage.values.size).toBe(0);
});
