import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";
import { CommandParser, serializeCommandIR, toCommandIR, type CommandTreeNode } from "@je2be/core";

it("starts load and tick functions, then refuses an unsafe restart", async () => {
  const pack = mkdtempSync(join(paths.servers, "runtime-startup-"));
  try {
    mkdirSync(join(pack, "scripts"));
    cpSync(new URL("../pack/scripts/main.js", import.meta.url), join(pack, "scripts/main.js"));
    const tree = JSON.parse(readFileSync(join(paths.servers, "reports-26.3/reports/commands.json"), "utf8")) as CommandTreeNode;
    const parser = new CommandParser(tree, { textFormat: "snbt" });
    const line = (source: string) => {
      const result = parser.parse(source);
      if (!result.ok) throw Error(result.error.message);
      return serializeCommandIR({ grammarVersion: "26.3", textFormat: "snbt", ir: toCommandIR(source, result.nodes) });
    };
    const data = {schemaVersion: 1, packs: [{functions: {
      "test:load": [line("scoreboard players set #load clock 7")],
      "test:tick": [line("scoreboard players add #tick clock 1")],
    }, tags: {"minecraft:load": {values: ["test:load"]}, "minecraft:tick": {values: ["test:tick"]}}}]};
    writeFileSync(join(pack, "scripts/data.js"), 'export const objectives = [["clock", [["#tick", 0]]]]; export const entities = [];');
    writeFileSync(join(pack, "scripts/datapacks.js"), `export const datapacks = ${JSON.stringify(data)};`);
    writeFileSync(join(pack, "scripts/storage.js"), "export const storage = [];");
    writeFileSync(join(pack, "manifest.json"), JSON.stringify({format_version: 2, header: {name: "runtime startup test", description: "startup probe", uuid: "0fe4c6eb-0bf2-46ca-9567-feb29e384d9e", version: [0,1,0], min_engine_version: [1,26,60]}, modules: [{type: "script", language: "javascript", uuid: "a8f76311-735e-46a4-b5dd-98f97e71373d", version: [0,1,0], entry: "scripts/main.js"}], dependencies: [{module_name: "@minecraft/server", version: "2.12.0-beta"}]}));
    let bds = await BedrockServer.start({behaviorPacks: [pack], tickingArea: false});
    try {
      await bds.waitForLog(l => l.includes("[je2be] initialized"), 30000, "initialization");
      const scores = await bds.request<{objective: string; scores: {participant: string; score: number}[]}[]>("scores");
      const rows = scores.result?.find(o => o.objective === "clock")?.scores;
      expect(rows?.find(row => row.participant === "#load")?.score).toBe(7);
      expect(rows?.find(row => row.participant === "#tick")?.score).toBeGreaterThan(0);
      bds = await bds.restart();
      await bds.waitForLog(l => l.includes("refusing to restart"), 30000, "restart guard");
    } finally { await bds.stop(); }
  } finally { rmSync(pack, {recursive: true, force: true}); }
});
