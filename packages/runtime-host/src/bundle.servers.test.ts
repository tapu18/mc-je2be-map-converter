import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";

it("loads the production bundle and executes a core score instruction on BDS three times", async () => {
  const pack = mkdtempSync(join(paths.servers, "runtime-bundle-"));
  try {
    mkdirSync(join(pack, "scripts"));
    cpSync(new URL("../pack/scripts/main.js", import.meta.url), join(pack, "scripts/main.js"));
    writeFileSync(join(pack, "scripts/data.js"), "export const objectives = []; export const entities = [];\n");
    writeFileSync(join(pack, "scripts/datapacks.js"), 'export const datapacks = {schemaVersion: 1, packs: []};\n');
    writeFileSync(join(pack, "scripts/storage.js"), 'export const storage = [];\n');
    writeFileSync(join(pack, "scripts/probe.js"), `
import { world } from "@minecraft/server";
import { executeInstruction } from "./main.js";
world.afterEvents.worldLoad.subscribe(() => {
  const scores = new Map();
  const result = executeInstruction({ hasObjective: id => id === "test", setScore: (holder, objective, value) => scores.set(holder + ":" + objective, value) },
    { kind: "scoreboard.players.set", holder: "alice", objective: "test", value: 42 });
  console.warn("RUNTIME_BUNDLE " + JSON.stringify({ result, score: scores.get("alice:test"), end: Date.now() }));
});
`);
    writeFileSync(join(pack, "manifest.json"), JSON.stringify({
      format_version: 2,
      header: { name: "runtime bundle test", description: "core bundle probe", uuid: "e5693acb-1af8-49b3-8a8a-126525bca607", version: [0, 1, 0], min_engine_version: [1, 26, 60] },
      modules: [{ type: "script", language: "javascript", uuid: "6f6b1259-bf61-4f01-93b2-27ff5b28ad98", version: [0, 1, 0], entry: "scripts/probe.js" }],
      dependencies: [{ module_name: "@minecraft/server", version: "2.12.0-beta" }],
    }));
    const warmup = await BedrockServer.start({ tickingArea: false });
    await warmup.stop();
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = Date.now();
      const bds = await BedrockServer.start({ behaviorPacks: [pack], tickingArea: false });
      try {
        const line = await bds.waitForLog(line => line.includes("RUNTIME_BUNDLE "), 60_000, "runtime bundle probe");
        const result = JSON.parse(line.slice(line.indexOf("RUNTIME_BUNDLE ") + "RUNTIME_BUNDLE ".length));
        expect(result).toMatchObject({ result: { success: true, result: 42 }, score: 42 });
        runs.push(result.end - start);
      } finally { await bds.stop(); }
    }
    const measurement = { bundleBytes: statSync(join(pack, "scripts/main.js")).size, startToResultMs: runs };
    writeFileSync(join(paths.servers, "runtime-bundle-results.json"), JSON.stringify(measurement, null, 2) + "\n");
    expect(readFileSync(join(pack, "scripts/main.js"), "utf8")).toContain("executeInstruction");
  } finally { rmSync(pack, { recursive: true, force: true }); }
});
