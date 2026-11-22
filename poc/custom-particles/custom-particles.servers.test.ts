import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMcstructure } from "@je2be/core";
import { BedrockServer } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
const pack = join(here, "pack");
describe("custom particle PoC", () => {
  it("measures handler, target and spawn loop three times", async () => {
    const dir = join(pack, "structures", "je2be");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "empty.mcstructure"), buildMcstructure({ size: [1, 2, 1], blocks: [] }));
    const bds = await BedrockServer.start({ behaviorPacks: [pack] });
    try {
      await bds.exec("gametest run je2be:particle_listener");
      await bds.waitForLog((line) => line.includes("PARTICLE_LISTENER_READY"), 10000, "listener");
      const runs: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        const start = bds.log.length;
        await bds.exec("je2be:particleprobe");
        for (const count of [1, 100, 1000]) {
          await bds.exec(`scriptevent je2be:particle-poc ${count}`);
          await bds.waitForLog((line) => line.includes('"event":"sample"') && line.includes(`"count":${count},`) && bds.log.slice(start).includes(line), 10000, "sample");
        }
        const entries = bds.log.slice(start).filter((line) => line.includes("PARTICLE_POC ")).map((line) => JSON.parse(line.slice(line.indexOf("PARTICLE_POC ") + 13)));
        expect(entries.filter((e) => e.event === "sample").map((e) => e.count)).toEqual([1, 100, 1000]);
        expect(entries.filter((e) => e.event === "sample").map((e) => e.targeted)).toEqual(["ok", "ok", "ok"]);
        expect(entries.find((e) => e.event === "handler")?.result).toContain("restricted execution");
        const deferred = entries.find((e) => e.event === "deferred");
        expect(deferred).toMatchObject({ result: "ok", tick: deferred.handlerTick });
        runs.push(entries);
      }
      if (process.env.JE2BE_RECORD === "1") writeFileSync(join(here, "results.json"), JSON.stringify({ runs }, null, 2) + "\n");
    } finally { await bds.stop(); }
  }, 120000);
});
