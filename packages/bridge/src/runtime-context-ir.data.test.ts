import { readFileSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { expect, it } from "vitest";
import {
  CommandParser, defaultExecutionContext, entityTarget, evaluatesInRuntime, executeCommand,
  MappingLookup, nbtToPlain, resolvePosition, rewriteNativeCommand, RuntimeState, selectEntities, toCommandIR,
  type Block, type CommandTreeNode, type ExecutionContext, type ExecutionHost, type Position, type Rotation, type RuntimeEntity,
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

type FakeEntity = RuntimeEntity & {motion?: Position; uuid?: [number, number, number, number]};

class FakeHost implements ExecutionHost {
  readonly candidates: FakeEntity[];
  readonly blocks: Map<string, Block>;
  readonly forcedChunks: Set<string>;
  readonly state = new RuntimeState(this);
  readonly delegated: {command: string; context: ExecutionContext}[] = [];
  delegate?: ExecutionHost["runNative"];
  private readonly teams = new Set<string>();
  private nextEntityId: number;

  constructor(candidates: FakeEntity[] = [], blocks = new Map<string, Block>(), forcedChunks = new Set<string>()) {
    this.candidates = candidates;
    this.blocks = blocks;
    this.forcedChunks = forcedChunks;
    this.nextEntityId = Math.max(0, ...candidates.map(entity => Number(entity.id.slice("entity-".length)))) + 1;
  }

  entities() { return this.candidates; }

  // Java gives every entity a Motion; summoned fixtures default to rest.
  entityMotion(id: string) { const entity = this.candidates.find(entity => entity.id === id); return entity && (entity.motion ?? [0, 0, 0]); }

  entityUuid(id: string) { return this.candidates.find(entity => entity.id === id)?.uuid; }

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
    if (this.delegate) return this.delegate(command, context, source);
    if (command.name === "team") {
      const [action, team, members] = command.nodes;
      if (team?.value?.kind !== "word" && team?.value?.kind !== "string") throw new Error("Expected fixture team name");
      const name = team.value.value;
      if (action?.name === "add") {
        if (this.teams.has(name)) throw new Error("Duplicate fixture team");
        this.teams.add(name);
        return {success: true, result: this.teams.size} as const;
      }
      const target = entityTarget(members?.value);
      const entities = target && selectEntities(this, context, target, this.state.scores);
      if (action?.name !== "join" || !this.teams.has(name) || !entities?.length) throw new Error("Invalid fixture team join");
      for (const entity of entities) entity.team = name;
      return {success: true, result: entities.length} as const;
    }
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
      const entities = selector && selectEntities(this, context, selector, this.state.scores);
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
    if (command.name !== "summon") return;
    const [type, position, dataNode] = command.nodes;
    if (type?.value?.kind !== "resource" || position?.value?.kind !== "coordinates") throw new Error("Invalid summon fixture");
    const id = type.value.id;
    if (id !== "minecraft:marker" && id !== "minecraft:armor_stand") throw new Error(`Unsupported fixture entity ${id}`);
    const data = dataNode?.value?.kind === "nbt"
      ? nbtToPlain(dataNode.value.value) as {Tags?: string[]; Rotation?: Rotation; Motion?: Position; UUID?: [number, number, number, number]} : {};
    this.candidates.push({
      id: `entity-${this.nextEntityId++}`, type: id, tags: data.Tags ?? [], rotation: data.Rotation ?? [0, 0],
      ...(data.Motion && {motion: data.Motion}), ...(data.UUID && {uuid: data.UUID}),
      position: resolvePosition(position, source, context), dimension: context.dimension,
      eyeHeight: id === "minecraft:armor_stand" ? 1.7775 : 0,
    });
    return {success: true, result: 1} as const;
  }
}

it("delegates rewritten and unchanged terminals with the resolved execute context and projected scores", () => {
  const candidate: RuntimeEntity = {
    id: "entity-1", type: "minecraft:armor_stand", tags: ["delegated"],
    position: [12.25, 70, -4.5], rotation: [90, 15], dimension: nether, eyeHeight: 1.7,
  };
  const host = new FakeHost([candidate]);
  const mappings = new MappingLookup({
    schemaVersion: 1, source: {repository: "", revision: "", javaVersion: "", bedrockVersion: "", sha256: {}}, blocks: [], items: [],
  });
  const projected: (number | undefined)[] = [];
  const observed: (number | undefined)[] = [];
  host.delegate = (_command, context, source) => {
    const rewrite = rewriteNativeCommand(source, {parser, mappings, blockDefaults: () => undefined});
    if (rewrite.status === "rewritten" || rewrite.status === "unchanged") {
      host.delegated.push({command: rewrite.command, context});
      observed.push(projected.at(-1));
      return {success: true, result: 1};
    }
  };
  host.state.functions.set("test:delegate", [
    parse("scoreboard objectives add t dummy"),
    parse("scoreboard players set alice t 42"),
    parse("execute as @e[tag=delegated] at @s run say hello"),
    parse("scoreboard players add alice t 1"),
    parse('return run execute as @e[tag=delegated] at @s run tellraw @s {score:{name:"alice",objective:"t"}}'),
  ]);
  const result = executeCommand(host.state, parse("function test:delegate"), undefined, undefined, () => {
    projected.push(host.state.scores.get("alice", "t"));
    return undefined;
  });
  const context = {executor: candidate.id, position: candidate.position, rotation: candidate.rotation, dimension: nether, anchor: "feet"};
  expect(result).toEqual({success: true, result: 1});
  expect(host.delegated).toEqual([
    {command: "say hello", context},
    {command: 'tellraw @s {"rawtext":[{"score":{"name":"alice","objective":"t"}}]}', context},
  ]);
  expect(observed).toEqual([42, 43]);

  host.state.functions.set("test:unsupported", [parse("advancement grant @a everything"), parse("scoreboard players set alice t 99")]);
  expect(executeCommand(host.state, parse("function test:unsupported"))).toEqual({success: false, error: "unsupported command"});
  expect(host.state.scores.get("alice", "t")).toBe(43);
});

it("propagates an unknown native result through function and store without writing a result", () => {
  const host = new FakeHost();
  host.delegate = () => ({status: "unknown"});
  host.state.scores.addObjective("t");
  host.state.functions.set("test:delegate", [parse("say hello"), parse("scoreboard players set after t 1")]);
  const result = executeCommand(host.state, parse("execute store success score outcome t run function test:delegate"));
  expect(result).toEqual({status: "unknown"});
  expect(host.state.scores.get("after", "t")).toBeUndefined();
  expect(host.state.scores.get("outcome", "t")).toBeUndefined();
});

const scenarioIds = ["execute-context", "execute-anchor", "execute-dimension", "calls", "execute-order", "execute-order-reload", "execute-extra", "score-selector-conditions", "entity-nbt-read"];
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

it("filters player gamemodes, team membership and runtime scores before applying limit", () => {
  const candidates = ([
    {id: "entity-1", type: "minecraft:player", name: "Builder", gamemode: "creative", team: "red"},
    {id: "entity-2", type: "minecraft:player", name: "Explorer", gamemode: "survival"},
    {id: "entity-3", type: "minecraft:marker"},
  ] as const).map((entity): RuntimeEntity => ({
    tags: [], position: [0, 0, 0], rotation: [0, 0], dimension: overworld, eyeHeight: 0, ...entity,
  }));
  const {state} = new FakeHost(candidates);
  const run = (line: string) => executeCommand(state, parse(line));
  expect(run("scoreboard objectives add __proto__ dummy").success).toBe(true);
  expect(run("scoreboard players set Explorer __proto__ 4").success).toBe(true);
  expect(run("scoreboard players set @e[type=marker] __proto__ 4").success).toBe(true);
  expect(run("execute if entity @e[gamemode=creative,team=red]")).toEqual({success: true, result: 1});
  expect(run("execute if entity @e[gamemode=!creative,team=]")).toEqual({success: true, result: 1});
  expect(run("scoreboard players remove @e[scores={__proto__=4},gamemode=!creative,limit=1] __proto__ 1"))
    .toEqual({success: true, result: 3});
  expect(state.scores.get("entity-3", "__proto__")).toBe(4);
  expect(run("execute as @a[scores={__proto__=3}] unless entity @s[team=red]"))
    .toEqual({success: true, result: 1});
  expect(run("scoreboard players set @e[team=] __proto__ -2147483648").success).toBe(true);
  expect(run("scoreboard players remove @e[scores={__proto__=-2147483648}] __proto__ 1"))
    .toEqual({success: true, result: -2});
});

it("distinguishes a missing score from an unknown objective in unless score", () => {
  const {state} = new FakeHost();
  const run = (line: string) => executeCommand(state, parse(line));
  expect(run("scoreboard objectives add result dummy").success).toBe(true);
  expect(run("execute store result score #missing result unless score #entry result matches 1"))
    .toEqual({success: true, result: 1});
  expect(run("execute store result score #unknown result unless score #entry result = #entry unknown"))
    .toEqual({success: false, error: "unknown objective"});
  expect(run("execute store result score #skipped result unless score #entry unknown matches 1 run scoreboard players set #ran result 42"))
    .toEqual({success: false, error: "unknown objective"});
  expect(Object.fromEntries(state.scores.objectives.get("result")!)).toEqual({"#missing": 1, "#unknown": 0});
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
  expect(run("execute store result score #unloaded probe unless blocks 1000000 0 1000000 1000000 0 1000000 16 0 16 all"))
    .toEqual({success: false, error: "block position not loaded"});
  expect(state.scores.get("#unloaded", "probe")).toBe(0);
});

it("applies terminal condition stores in selector order", () => {
  const {state} = new FakeHost();
  const run = (line: string) => executeCommand(state, parse(line));
  for (const line of [
    "scoreboard objectives add probe dummy",
    "setblock 20 70 20 stone",
    "setblock 8 -59 8 stone",
    "summon marker 8 -60 8",
    "summon marker 12 -60 12",
  ]) expect(run(line), line).toMatchObject({success: true});
  for (const [sort, expected] of [["nearest", 0], ["furthest", 1]] as const) {
    const line = `execute store result score #order probe as @e[type=marker,sort=${sort}] at @s if blocks ~ ~1 ~ ~ ~1 ~ 20 70 20 all`;
    expect(run(line)).toEqual({success: true, result: 1});
    expect(state.scores.get("#order", "probe")).toBe(expected);
  }
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

it("rejects entity NBT outside the virtual layer with a reason instead of delegating it", () => {
  const host = new FakeHost();
  const {state} = host;
  const run = (line: string) => executeCommand(state, parse(line));
  expect(run("summon marker 8 -60 8 {Tags:[\"probe\"],UUID:[I;1,2,3,4]}").success).toBe(true);
  const delegated: string[] = [];
  host.delegate = (_command, _context, source) => { delegated.push(source); return {success: true, result: 1}; };
  const rejected = {
    "data get entity @e[tag=probe,limit=1] Health": "entity NBT path Health is not supported",
    "data get entity @e[tag=probe,limit=1] Pos[0].x": "entity NBT path Pos[0].x is not supported",
    "data get entity @e[tag=probe,limit=1] Pos[]": "entity NBT path Pos[] is not supported",
    "data get entity @e[tag=probe,limit=1] {Pos:[0d]}": "entity NBT path {Pos:[0d]} is not supported",
    "data get entity @e[tag=probe,limit=1]": "reading an entity's whole NBT is not supported",
    "data get entity @e[tag=probe,limit=1,nbt={OnGround:1b}] Pos": "entity selector @e[tag=probe,limit=1,nbt={OnGround:1b}] is not supported",
    "data modify entity @e[tag=probe,limit=1] Pos set value [0d,0d,0d]": "writing entity NBT (data modify entity) is not supported",
    "data merge entity @e[tag=probe,limit=1] {Invisible:1b}": "writing entity NBT (data merge entity) is not supported",
    "data remove entity @e[tag=probe,limit=1] Tags": "writing entity NBT (data remove entity) is not supported",
    "data modify storage test:nbt x set from entity @e[tag=probe,limit=1] Health": "entity NBT path Health is not supported",
    "data modify storage test:nbt x set string entity @e[tag=probe,limit=1] UUID": "data modify ... string entity is not supported",
    "data modify block 0 -60 0 Items set from entity @e[tag=probe,limit=1] Pos": "copying entity NBT into data modify block is not supported",
  };
  for (const [line, reason] of Object.entries(rejected)) {
    const result = run(line);
    expect(result, line).toMatchObject({success: false});
    expect("error" in result && result.error, line).toBe(`unsupported entity NBT: ${reason}${reason.includes("path") && !reason.includes("whole") ? "; readable paths are Pos, Pos[n], Rotation, Rotation[n], Motion, Motion[n], UUID, UUID[n]" : ""}`);
    expect(evaluatesInRuntime(parse(line)), line).toBe(false);
  }
  // A rejected line stops its function like other unsupported commands.
  state.functions.set("test:entity", [parse("data get entity @e[tag=probe,limit=1] Health"), parse("data modify storage test:nbt after set value 1")]);
  expect(run("function test:entity")).toMatchObject({success: false, error: expect.stringMatching(/^unsupported entity NBT: /)});
  expect(state.storage.values.size).toBe(0);
  expect(delegated).toEqual([]);
});

it("reads the virtual layer only for exactly one entity with host-supplied values", () => {
  const host = new FakeHost();
  const {state} = host;
  const run = (line: string) => executeCommand(state, parse(line));
  expect(run("summon marker 8 -60 8 {Tags:[\"probe\"]}").success).toBe(true);
  expect(run("summon marker 9 -60 8 {Tags:[\"probe\"]}").success).toBe(true);
  expect(evaluatesInRuntime(parse("data get entity @e[tag=probe,limit=1] Pos[0]"))).toBe(true);
  // The parser already rejects selectors that may match several entities, as Java does.
  expect(parser.parse("data get entity @e[tag=probe] Pos[0]").ok).toBe(false);
  expect(run("data get entity @e[tag=missing,limit=1] Pos[0]")).toEqual({success: false, error: "no entity was found"});
  expect(run("data get entity @e[tag=probe,limit=1] Pos[3]")).toEqual({success: false, error: "no elements match the path"});
  expect(run("data get entity @e[tag=probe,limit=1] Pos[0] 2")).toEqual({success: true, result: 17});
  // The summoned fixture has no Java UUID: the host cannot supply one.
  expect(run("data get entity @e[tag=probe,limit=1] UUID")).toEqual({success: false, error: "unsupported entity NBT: the host holds no Java UUID for the entity"});
});
