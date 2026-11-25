import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";

it("persists score and storage across BDS restarts three times", async () => {
  const dir = mkdtempSync(join(paths.servers, "persistence-"));
  const pack = join(dir, "pack"), saved = join(dir, "saved");
  mkdirSync(join(pack, "scripts"), {recursive: true});
  cpSync(new URL("../pack/scripts/main.js", import.meta.url), join(pack, "scripts/main.js"));
  writeFileSync(join(pack, "scripts/data.js"), "export const objectives = []; export const entities = [];\n");
  writeFileSync(join(pack, "scripts/probe.js"), `
import { world } from "@minecraft/server";
import { RuntimeState, commitState, restoreState } from "./main.js";
world.afterEvents.worldLoad.subscribe(() => {
 try {
  const properties = {get: key => world.getDynamicProperty(key), set: (key, value) => world.setDynamicProperty(key, value)};
  const state = restoreState(properties);
  if (!state) {
   const initial = new RuntimeState(); initial.scores.addObjective("points"); initial.scores.set("alice", "points", 42);
   initial.storage.values.set("test:data", {type:"compound", value:new Map([["value", {type:"string", value:"persisted"}]])});
   commitState(properties, initial); console.warn("PERSISTENCE_WRITE");
  } else console.warn("PERSISTENCE_READ " + JSON.stringify({score:state.scores.get("alice", "points"), value:state.storage.get("test:data").value.get("value").value}));
 } catch (error) { console.warn("PERSISTENCE_ERROR " + String(error)); }
});
`);
  writeFileSync(join(pack, "manifest.json"), JSON.stringify({format_version: 2, header: {name:"persistence test", description:"restart probe", uuid:"e5693acb-1af8-49b3-8a8a-126525bca607", version:[0,1,0], min_engine_version:[1,26,60]}, modules:[{type:"script", language:"javascript", uuid:"6f6b1259-bf61-4f01-93b2-27ff5b28ad98", version:[0,1,0], entry:"scripts/probe.js"}], dependencies:[{module_name:"@minecraft/server", version:"2.12.0-beta"}]}));
  try {
    for (let i = 0; i < 3; i++) {
      const first = await BedrockServer.start({behaviorPacks:[pack], tickingArea:false});
      try { const line = await first.waitForLog(l => l.includes("PERSISTENCE_"), 60000, "persistence write"); expect(line).toContain("PERSISTENCE_WRITE"); } finally { await first.stop(); }
      cpSync(join(paths.bedrockServer, "worlds", "je2be-test"), saved, {recursive:true});
      const second = await BedrockServer.start({world:saved, behaviorPacks:[pack], tickingArea:false});
      try { const line = await second.waitForLog(l => l.includes("PERSISTENCE_"), 60000, "persistence read"); expect(line).toContain('PERSISTENCE_READ {"score":42,"value":"persisted"}'); } finally { await second.stop(); }
      rmSync(saved, {recursive:true, force:true});
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
