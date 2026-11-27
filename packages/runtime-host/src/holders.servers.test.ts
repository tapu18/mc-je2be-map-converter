import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";
import { buildMcstructure, rewriteNativeCommand, toCommandIR } from "@je2be/core";
import { loadRewriteContext } from "@je2be/converter";
import { writeStructure } from "../../bridge/src/poc-kit.ts";
import { rewriteResources } from "../../bridge/src/rewrite-resources.ts";

const rewrite = loadRewriteContext(await rewriteResources(), "snbt");
const parse = (source: string) => {
  const parsed = rewrite.parser.parse(source);
  if (!parsed.ok) throw Error(`${source}: ${parsed.error.message}`);
  return toCommandIR(source, parsed.nodes);
};
const native = (source: string) => {
  const result = rewriteNativeCommand(source, rewrite);
  if (result.status !== "rewritten" && result.status !== "unchanged") throw Error(JSON.stringify(result));
  return [source, result.command] as const;
};
function writePack(pack: string, data: string, probe: string, gametest: boolean): void {
  mkdirSync(join(pack, "scripts"), {recursive: true});
  cpSync(new URL("../pack/scripts/main.js", import.meta.url), join(pack, "scripts/main.js"));
  writeFileSync(join(pack, "scripts/data.js"), data);
  writeFileSync(join(pack, "scripts/storage.js"), "export const storage = [];\n");
  writeFileSync(join(pack, "scripts/datapacks.js"), "export const datapacks = {schemaVersion: 1, packs: []};\n");
  writeFileSync(join(pack, "scripts/probe.js"), probe);
  writeFileSync(join(pack, "manifest.json"), JSON.stringify({
    format_version: 2,
    header: {name: "holder test", description: "holder probe", uuid: "0b6a3a51-87c4-4d71-9d1e-5d63c2b3f1a7", version: [0, 1, 0], min_engine_version: [1, 26, 60]},
    modules: [{type: "script", language: "javascript", uuid: "5e0d0a8e-3f6c-4c39-a2b4-7f3f3c8c51d2", version: [0, 1, 0], entry: "scripts/probe.js"}],
    dependencies: [{module_name: "@minecraft/server", version: "2.12.0-beta"}, ...gametest ? [{module_name: "@minecraft/server-gametest", version: "1.0.0-beta"}] : []],
  }));
}
/** Core resets entity holders by their runtime holder (the BE entity ID); the probe fills in the ID. */
const resetById = parse("scoreboard players reset 0 held");
const describe = `const resetById = (id, ir = ${JSON.stringify(resetById)}) => ({...ir, source: "scoreboard players reset " + id + " held", command: {...ir.command, nodes: ir.command.nodes.map(node => node.name === "targets" ? {...node, value: {kind: "name", value: id}} : node)}});
const describe = (objective, holder) => objective.hasParticipant(holder) ? objective.getScore(holder) : null;
const entityId = participant => { try { return participant.getEntity()?.id ?? null; } catch { return "unloaded"; } };
const participants = objective => objective.getParticipants().map(p => [p.type, p.type === "FakePlayer" ? p.displayName : entityId(p)]).sort();`;

it("projects player and entity holders so native commands read @s scores three times", async () => {
  const lines = [
    "scoreboard objectives add held dummy",
    "scoreboard players set Delegate held 1",
    "execute as Delegate run scoreboard players set @s held 7",
    "execute as @e[type=minecraft:armor_stand,tag=held] run scoreboard players set @s held 5",
    "scoreboard players set #fake held 3",
    "execute as Delegate run tag @s[scores={held=7}] add seen_player",
    "execute as @e[type=minecraft:armor_stand,tag=held] run tag @s[scores={held=5}] add seen_entity",
  ];
  const nativeCommands = lines.slice(5).map(native);
  const pack = mkdtempSync(join(paths.servers, "holder-test-"));
  try {
    writePack(pack, "export const objectives = []; export const entities = [];\n", `
import { world } from "@minecraft/server";
import { register } from "@minecraft/server-gametest";
import { RuntimeSession } from "./main.js";
${describe}
register("je2be", "score_holders", test => {
  try {
    const player = test.spawnSimulatedPlayer({x: 0, y: 0, z: 0}, "Delegate");
    const stand = test.spawn("minecraft:armor_stand", {x: 0, y: 1, z: 0});
    stand.addTag("held");
    const commands = new Map(${JSON.stringify(nativeCommands)});
    const session = new RuntimeSession(undefined, source => {
      const command = commands.get(source);
      if (command) return {command, completion: "synchronous"};
    });
    session.state.functions.set("test:holders", ${JSON.stringify(lines.map(parse))});
    const result = session.execute(${JSON.stringify(parse("function test:holders"))});
    const objective = world.scoreboard.getObjective("held");
    const projected = {player: describe(objective, player), stand: describe(objective, stand), fake: describe(objective, "#fake"),
      playerParticipant: objective.hasParticipant(player), participants: participants(objective)};
    const tags = {player: player.getTags().sort(), stand: stand.getTags().sort()};
    const nativeChange = session.runNative("overworld", "scoreboard players add @e[type=armor_stand,tag=held] held 10", "synchronous");
    const nativeReset = session.runNative("overworld", "scoreboard players reset Delegate held", "synchronous");
    session.syncScores();
    const synced = Object.fromEntries([...session.state.scores.objectives.get("held")].map(([holder, value]) => [holder === stand.id ? "stand" : holder, value]));
    const reset = session.execute(resetById(stand.id));
    const after = {stand: describe(objective, stand), participants: participants(objective)};
    console.warn("HOLDER_PROBE " + JSON.stringify({ids: {player: player.id, stand: stand.id}, result, projected, tags, nativeChange, nativeReset, synced, reset, after}));
    test.succeed();
  } catch (error) { console.warn("HOLDER_PROBE_ERROR " + error + " " + error.stack); }
}).structureName("je2be:empty");
`, true);
    writeStructure(pack, "empty", buildMcstructure({size: [1, 2, 1], blocks: []}));
    for (let i = 0; i < 3; i++) {
      const bds = await BedrockServer.start({behaviorPacks: [pack]});
      try {
        expect(await bds.exec("gametest run je2be:score_holders")).toMatchObject({ok: true, result: {successCount: 1}});
        const line = await bds.waitForLog(line => line.includes("HOLDER_PROBE ") || line.includes("HOLDER_PROBE_ERROR "), 10_000, "holder probe");
        if (line.includes("HOLDER_PROBE_ERROR ")) throw Error(line);
        const probe = JSON.parse(line.split("HOLDER_PROBE ")[1]!);
        expect(probe).toMatchObject({
          result: {status: "executed", core: {success: true}, projection: {ok: true}},
          projected: {player: 7, stand: 5, fake: 3, playerParticipant: true,
            participants: [["Entity", probe.ids.stand], ["FakePlayer", "#fake"], ["Player", probe.ids.player]]},
          tags: {player: ["seen_player"], stand: ["held", "seen_entity"]},
          nativeChange: {status: "executed", result: {ok: true, value: {status: "known", successCount: 1}}},
          nativeReset: {status: "executed", result: {ok: true}},
          synced: {"#fake": 3, stand: 15},
          reset: {status: "executed", core: {success: true}, projection: {ok: true}},
          after: {stand: null, participants: [["FakePlayer", "#fake"]]},
        });
      } finally { await bds.stop(); }
    }
  } finally { rmSync(pack, {recursive: true, force: true}); }
});

it("keeps entity holders on the entity across BDS restarts three times", async () => {
  const dir = mkdtempSync(join(paths.servers, "holder-restart-"));
  const pack = join(dir, "pack"), saved = join(dir, "saved");
  const set = parse("execute as @e[type=minecraft:armor_stand,tag=held] run scoreboard players set @s held 7");
  const fake = parse("scoreboard players set #fake held 3");
  const change = parse("execute as @e[type=minecraft:armor_stand,tag=held] run scoreboard players remove @s held 1");
  writePack(pack, 'export const objectives = [["held", []]]; export const entities = [];\n', `
import { world, system } from "@minecraft/server";
import { session } from "./main.js";
${describe}
const run = ir => { const result = session.execute(ir); if (result.status !== "executed" || !result.projection.ok || !result.core.success) throw Error(JSON.stringify(result)); };
world.afterEvents.worldLoad.subscribe(() => {
  const dim = world.getDimension("overworld"), pos = {x: 0.5, y: -59, z: 0.5};
  const early = world.getDynamicProperty("probe:written") ? participants(world.scoreboard.getObjective("held")) : [];
  const poll = system.runInterval(() => {
    try {
      if (!session || !dim.getBlock(pos)) return;
      const objective = world.scoreboard.getObjective("held");
      if (!world.getDynamicProperty("probe:written")) {
        const stand = dim.spawnEntity("minecraft:armor_stand", pos);
        stand.addTag("held");
        run(${JSON.stringify(set)}); run(${JSON.stringify(fake)});
        world.setDynamicProperty("probe:written", stand.id);
        system.clearRun(poll);
        system.runTimeout(() => console.warn("HOLDER_WRITE " + JSON.stringify({stand: describe(objective, stand), participants: participants(objective)})), 5);
        return;
      }
      const stand = dim.getEntities({tags: ["held"]})[0];
      if (!stand) return;
      system.clearRun(poll);
      const id = world.getDynamicProperty("probe:written");
      const restored = {sameId: stand.id === id, runtime: session.state.scores.get(stand.id, "held"), stand: describe(objective, stand), early, participants: participants(objective)};
      run(${JSON.stringify(change)});
      const changed = {runtime: session.state.scores.get(stand.id, "held"), stand: describe(objective, stand)};
      run(resetById(stand.id));
      const removed = {runtime: session.state.scores.get(stand.id, "held") ?? null, stand: describe(objective, stand), participants: participants(objective)};
      console.warn("HOLDER_READ " + JSON.stringify({id, restored, changed, removed}));
    } catch (error) { system.clearRun(poll); console.warn("HOLDER_ERROR " + error + " " + error.stack); }
  }, 1);
});
`, false);
  try {
    for (let i = 0; i < 3; i++) {
      const first = await BedrockServer.start({behaviorPacks: [pack]});
      let written: {participants: unknown[]};
      try {
        const line = await first.waitForLog(l => l.includes("HOLDER_WRITE ") || l.includes("HOLDER_ERROR "), 60_000, "holder write");
        if (line.includes("HOLDER_ERROR ")) throw Error(line);
        written = JSON.parse(line.split("HOLDER_WRITE ")[1]!);
        expect(written).toMatchObject({stand: 7});
      } finally { await first.stop(); }
      cpSync(join(paths.bedrockServer, "worlds", "je2be-test"), saved, {recursive: true});
      const second = await BedrockServer.start({world: saved, behaviorPacks: [pack]});
      try {
        const line = await second.waitForLog(l => l.includes("HOLDER_READ ") || l.includes("HOLDER_ERROR "), 60_000, "holder read");
        if (line.includes("HOLDER_ERROR ")) throw Error(line);
        const read = JSON.parse(line.split("HOLDER_READ ")[1]!);
        expect(read).toMatchObject({
          restored: {sameId: true, runtime: 7, stand: 7, participants: written.participants},
          changed: {runtime: 6, stand: 6},
          removed: {runtime: null, stand: null, participants: [["FakePlayer", "#fake"]]},
        });
        // Before the entity's chunk loads, startup projection must not create a fake player named by its ID.
        expect(read.restored.early).not.toContainEqual(["FakePlayer", read.id]);
      } finally { await second.stop(); }
      rmSync(saved, {recursive: true, force: true});
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
