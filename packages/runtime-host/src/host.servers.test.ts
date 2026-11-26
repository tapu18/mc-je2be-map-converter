import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";
import { buildMcstructure, CommandParser, rewriteNativeCommand, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { loadRewriteContext } from "@je2be/converter";
import { writeStructure } from "../../bridge/src/poc-kit.ts";
import { rewriteResources } from "../../bridge/src/rewrite-resources.ts";

it("projects core scores and exercises the Script API host on BDS three times", async () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, { textFormat: "snbt" });
  const lines = ["scoreboard objectives add test dummy", "scoreboard players set alice test 42", "scoreboard players reset alice test", "scoreboard objectives remove test"];
  const commands = lines.map(line => { const parsed = parser.parse(line); if (!parsed.ok) throw Error(parsed.error.message); return toCommandIR(line, parsed.nodes); });
  const pack = mkdtempSync(join(paths.servers, "host-test-"));
  try {
    mkdirSync(join(pack, "scripts"));
    cpSync(new URL("../pack/scripts/main.js", import.meta.url), join(pack, "scripts/main.js"));
    writeFileSync(join(pack, "scripts/data.js"), "export const objectives = []; export const entities = [];\n");
  writeFileSync(join(pack, "scripts/storage.js"), "export const storage = [];\n");
    writeFileSync(join(pack, "scripts/probe.js"), `
import { world } from "@minecraft/server";
import { RuntimeSession, candidates, entity, readBlock, writeBlock, nativeCommand, readProperty, writeProperty } from "./main.js";
world.afterEvents.worldLoad.subscribe(async () => {
 try {
  const dim = world.getDimension("overworld"), pos = {x: 0, y: 100, z: 0};
  await world.tickingAreaManager.createTickingArea("host_test", {dimension: dim, from: pos, to: pos});
  const session = new RuntimeSession(), commands = ${JSON.stringify(commands)};
  const add = session.execute(commands[0]), set = session.execute(commands[1]);
  const score = world.scoreboard.getObjective("test").getScore("alice");
  const reset = session.execute(commands[2]), remaining = world.scoreboard.getObjective("test").getParticipants().map(p => p.displayName);
  const remove = session.execute(commands[3]);
  const failure = new RuntimeSession(); world.scoreboard.addObjective("test", "test");
  const conflict = failure.execute(commands[0]), stopped = failure.execute(commands[1]);
  world.scoreboard.removeObjective("test");
  const write = writeBlock("overworld", pos, {type: "minecraft:stone", states: {}}), block = readBlock("overworld", pos);
  const outside = readBlock("overworld", {x: 0, y: 9999, z: 0});
  const spawned = dim.spawnEntity("minecraft:armor_stand", pos);
  const list = candidates("overworld"), found = entity(spawned.id);
  const removedId = spawned.id; spawned.remove();
  const missing = entity(removedId);
  const native = nativeCommand("overworld", "testforblock 0 100 0 stone", "synchronous");
  const nativeSession = new RuntimeSession();
  const unknown = nativeSession.runNative("overworld", "testforblock 0 100 0 stone", "deferred"), unknownStopped = nativeSession.execute(commands[0]);
  const unloaded = readBlock("overworld", {x: 100000, y: 100, z: 100000});
  const badBlock = writeBlock("overworld", pos, {type: "invalid:block", states: {}});
  const badNative = nativeCommand("overworld", "invalid_command", "synchronous");
  const propertyWrite = writeProperty("host:test", 42), property = readProperty("host:test");
  console.warn("HOST_PROBE " + JSON.stringify({add,set,score,reset,remaining,remove,conflict,stopped,write,block,outside,list,found,missing,native,unknown,unknownStopped,unloaded,badBlock,badNative,propertyWrite,property}));
 } catch (error) { console.warn("HOST_PROBE_ERROR " + String(error) + " " + error.stack); }
});
`);
    writeFileSync(join(pack, "manifest.json"), JSON.stringify({ format_version: 2, header: { name: "host test", description: "host probe", uuid: "e5693acb-1af8-49b3-8a8a-126525bca607", version: [0, 1, 0], min_engine_version: [1, 26, 60] }, modules: [{ type: "script", language: "javascript", uuid: "6f6b1259-bf61-4f01-93b2-27ff5b28ad98", version: [0, 1, 0], entry: "scripts/probe.js" }], dependencies: [{ module_name: "@minecraft/server", version: "2.12.0-beta" }] }));
    for (let i = 0; i < 3; i++) {
      const bds = await BedrockServer.start({ behaviorPacks: [pack], tickingArea: false });
      try {
        const line = await bds.waitForLog(line => line.includes("HOST_PROBE ") || line.includes("HOST_PROBE_ERROR "), 60_000, "host probe");
        if (line.includes("HOST_PROBE_ERROR ")) throw Error(line);
        const result = JSON.parse(line.slice(line.indexOf("HOST_PROBE ") + "HOST_PROBE ".length));
        expect(result).toMatchObject({ add: {core: {success: true}, projection: {ok: true}}, set: {core: {success: true, result: 42}, projection: {ok: true}}, score: 42, reset: {projection: {ok: true}}, remaining: [], remove: {projection: {ok: true}}, conflict: {projection: {ok: false}}, stopped: {status: "inconsistent"}, write: {ok: true}, block: {ok: true, value: {type: "minecraft:stone"}}, outside: {ok: false, error: {kind: "out-of-bounds"}}, list: {ok: true, value: {complete: false}}, found: {ok: true, value: {type: "minecraft:armor_stand"}}, missing: {ok: false, error: {kind: "absent"}}, native: {ok: true, value: {status: "known", successCount: 1}}, unknown: {result: {ok: true, value: {status: "unknown"}}}, unknownStopped: {status: "unknown-native"}, unloaded: {ok: false, error: {kind: "unloaded"}}, badBlock: {ok: false}, badNative: {ok: false}, propertyWrite: {ok: true}, property: {ok: true, value: 42} });
        expect(result.list.value.ids).toContain(result.found.value.id);
      } finally { await bds.stop(); }
    }
  } finally { rmSync(pack, { recursive: true, force: true }); }
});

it("delegates a function's setblock and score-bearing tellraw to BDS three times", async () => {
  const rewrite = loadRewriteContext(await rewriteResources(), "snbt");
  const lines = [
    "scoreboard objectives add delegated dummy",
    "scoreboard players set alice delegated 41",
    "execute as Delegate at @s positioned ~2 ~ ~ run setblock ~ ~2 ~ minecraft:stone",
    "scoreboard players add alice delegated 1",
    'return run execute as Delegate at @s run tellraw @s {score:{name:"alice",objective:"delegated"}}',
  ];
  const parse = (source: string) => {
    const parsed = rewrite.parser.parse(source);
    if (!parsed.ok) throw Error(`${source}: ${parsed.error.message}`);
    return toCommandIR(source, parsed.nodes);
  };
  const nativeCommands = [lines[2]!, lines[4]!].map(source => {
    const result = rewriteNativeCommand(source, rewrite);
    if (result.status !== "rewritten" && result.status !== "unchanged") throw Error(JSON.stringify(result));
    return [source, result.command];
  });
  const tag = "tag Delegate add prepared_native";
  const tagRewrite = rewriteNativeCommand(tag, rewrite);
  if (tagRewrite.status !== "unchanged" && tagRewrite.status !== "rewritten") throw Error(JSON.stringify(tagRewrite));
  const pack = mkdtempSync(join(paths.servers, "native-test-"));
  try {
    mkdirSync(join(pack, "scripts"));
    cpSync(new URL("../pack/scripts/main.js", import.meta.url), join(pack, "scripts/main.js"));
    writeFileSync(join(pack, "scripts/data.js"), `export const objectives = []; export const entities = [];
export const nativeCommands = ${JSON.stringify([[tag, tagRewrite.command]])};\n`);
    writeFileSync(join(pack, "scripts/storage.js"), "export const storage = [];\n");
    writeStructure(pack, "empty", buildMcstructure({size: [1, 2, 1], blocks: []}));
    writeFileSync(join(pack, "scripts/probe.js"), `
import { world } from "@minecraft/server";
import { register } from "@minecraft/server-gametest";
import { RuntimeSession, session as preparedSession } from "./main.js";
register("je2be", "native_delegate", test => {
  try {
    const player = test.spawnSimulatedPlayer({x: 0, y: 0, z: 0}, "Delegate");
    const prepared = preparedSession.execute(${JSON.stringify(parse(tag))});
    const {x, y, z} = player.location;
    const commands = new Map(${JSON.stringify(nativeCommands)}), observed = [];
    const session = new RuntimeSession(undefined, source => {
      const command = commands.get(source);
      if (!command) return;
      observed.push(world.scoreboard.getObjective("delegated")?.getScore("alice"));
      return {command, completion: "synchronous"};
    });
    session.state.functions.set("test:delegate", ${JSON.stringify(lines.map(parse))});
    const result = session.execute(${JSON.stringify(parse("function test:delegate"))});
    const block = player.dimension.getBlock({x: Math.floor(x) + 2, y: Math.floor(y) + 2, z: Math.floor(z)});
    const deferred = new RuntimeSession(undefined, () => ({command: "tag Delegate add deferred_native", completion: "deferred"}));
    const unknown = deferred.execute(${JSON.stringify(parse("tag Delegate add deferred_native"))});
    const stopped = deferred.execute(${JSON.stringify(parse(tag))});
    console.warn("NATIVE_PROBE " + JSON.stringify({result, observed, block: block?.typeId, prepared, tagged: player.hasTag("prepared_native"), unknown, stopped}));
    test.succeed();
  } catch (error) { console.warn("NATIVE_PROBE_ERROR " + error + " " + error.stack); }
}).structureName("je2be:empty");
`);
    writeFileSync(join(pack, "manifest.json"), JSON.stringify({
      format_version: 2,
      header: {name: "native test", description: "native probe", uuid: "abe092b0-3457-4e73-b041-9024e6eee86b", version: [0, 1, 0], min_engine_version: [1, 26, 60]},
      modules: [{type: "script", language: "javascript", uuid: "ca21baf0-a8ad-4932-9210-3a9226b2f44d", version: [0, 1, 0], entry: "scripts/probe.js"}],
      dependencies: [{module_name: "@minecraft/server", version: "2.12.0-beta"}, {module_name: "@minecraft/server-gametest", version: "1.0.0-beta"}],
    }));
    for (let i = 0; i < 3; i++) {
      const bds = await BedrockServer.start({behaviorPacks: [pack]});
      try {
        expect(await bds.exec("gametest run je2be:native_delegate")).toMatchObject({ok: true, result: {successCount: 1}});
        const line = await bds.waitForLog(line => line.includes("NATIVE_PROBE ") || line.includes("NATIVE_PROBE_ERROR "), 10_000, "native probe");
        if (line.includes("NATIVE_PROBE_ERROR ")) throw Error(line);
        expect(JSON.parse(line.split("NATIVE_PROBE ")[1]!)).toEqual({
          result: {status: "executed", core: {success: true, result: 1}, projection: {ok: true}},
          observed: [41, 42],
          block: "minecraft:stone",
          prepared: {status: "executed", core: {success: true, result: 1}, projection: {ok: true}},
          tagged: true,
          unknown: {status: "executed", core: {status: "unknown"}, projection: {ok: true}},
          stopped: {status: "unknown-native"},
        });
      } finally { await bds.stop(); }
    }
  } finally { rmSync(pack, {recursive: true, force: true}); }
});
