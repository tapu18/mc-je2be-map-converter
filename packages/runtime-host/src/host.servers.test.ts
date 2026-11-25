import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";
import { CommandParser, toCommandIR, type CommandTreeNode } from "@je2be/core";

it("projects core scores and exercises the Script API host on BDS three times", async () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, { textFormat: "snbt" });
  const lines = ["scoreboard objectives add test dummy", "scoreboard players set alice test 42", "scoreboard players reset alice test", "scoreboard objectives remove test"];
  const commands = lines.map(line => { const parsed = parser.parse(line); if (!parsed.ok) throw Error(parsed.error.message); return toCommandIR(line, parsed.nodes); });
  const pack = mkdtempSync(join(paths.servers, "host-test-"));
  try {
    mkdirSync(join(pack, "scripts"));
    cpSync(new URL("../pack/scripts/main.js", import.meta.url), join(pack, "scripts/main.js"));
    writeFileSync(join(pack, "scripts/data.js"), "export const objectives = []; export const entities = [];\n");
    writeFileSync(join(pack, "scripts/datapacks.js"), 'export const datapacks = {schemaVersion: 1, packs: []};\n');
    writeFileSync(join(pack, "scripts/storage.js"), 'export const storage = [];\n');
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
