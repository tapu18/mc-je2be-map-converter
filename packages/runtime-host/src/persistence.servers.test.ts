import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CommandParser, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { BedrockServer, paths } from "@je2be/bridge";

it("persists score and storage across BDS restarts three times", async () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const commands = ["scoreboard objectives add points dummy", "scoreboard players set alice points 42", 'data modify storage test:data value set value "persisted"'].map(line => {
    const parsed = parser.parse(line); if (!parsed.ok) throw Error(parsed.error.message); return toCommandIR(line, parsed.nodes);
  });
  const dir = mkdtempSync(join(paths.servers, "persistence-"));
  const pack = join(dir, "pack"), saved = join(dir, "saved");
  mkdirSync(join(pack, "scripts"), {recursive: true});
  cpSync(new URL("../pack/scripts/main.js", import.meta.url), join(pack, "scripts/main.js"));
  writeFileSync(join(pack, "scripts/data.js"), "export const objectives = []; export const entities = [];\n");
  writeFileSync(join(pack, "scripts/storage.js"), "export const storage = [];\n");
  writeFileSync(join(pack, "scripts/probe.js"), `
import { world, system } from "@minecraft/server";
import { session } from "./main.js";
world.afterEvents.worldLoad.subscribe(() => {
 system.runTimeout(() => {
  try {
   if (!session) throw Error("session unavailable");
   if (!world.getDynamicProperty("probe:written")) {
    for (const command of ${JSON.stringify(commands)}) { const result = session.execute(command); if (result.status !== "executed" || !result.projection.ok || !result.core.success) throw Error(JSON.stringify(result)); }
    world.setDynamicProperty("probe:written", true);
    system.runTimeout(() => console.warn("PERSISTENCE_WRITE"), 5);
   } else console.warn("PERSISTENCE_READ " + JSON.stringify({score:session.state.scores.get("alice", "points"), projected:world.scoreboard.getObjective("points").getScore("alice"), value:session.state.storage.get("test:data").value.get("value").value}));
  } catch (error) { console.warn("PERSISTENCE_ERROR " + String(error)); }
 }, 5);
});
`);
  writeFileSync(join(pack, "manifest.json"), JSON.stringify({format_version: 2, header: {name:"persistence test", description:"restart probe", uuid:"e5693acb-1af8-49b3-8a8a-126525bca607", version:[0,1,0], min_engine_version:[1,26,60]}, modules:[{type:"script", language:"javascript", uuid:"6f6b1259-bf61-4f01-93b2-27ff5b28ad98", version:[0,1,0], entry:"scripts/probe.js"}], dependencies:[{module_name:"@minecraft/server", version:"2.12.0-beta"}]}));
  try {
    for (let i = 0; i < 3; i++) {
      const first = await BedrockServer.start({behaviorPacks:[pack], tickingArea:false});
      try { const line = await first.waitForLog(l => l.includes("PERSISTENCE_"), 60000, "persistence write"); expect(line).toContain("PERSISTENCE_WRITE"); } finally { await first.stop(); }
      cpSync(join(paths.bedrockServer, "worlds", "je2be-test"), saved, {recursive:true});
      const second = await BedrockServer.start({world:saved, behaviorPacks:[pack], tickingArea:false});
      try { const line = await second.waitForLog(l => l.includes("PERSISTENCE_"), 60000, "persistence read"); expect(line).toContain('PERSISTENCE_READ {"score":42,"projected":42,"value":"persisted"}'); } finally { await second.stop(); }
      rmSync(saved, {recursive:true, force:true});
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
