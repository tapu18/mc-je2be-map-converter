import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
it("loads grammar and mappings and parses a first command on BDS three times", async () => {
  execFileSync(process.execPath, [join(here, "prepare.ts")]);
  const pack = join(here, "pack");
  // Create the reusable world template before measuring.
  const warmup = await BedrockServer.start({ tickingArea: false });
  await warmup.stop();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    const bds = await BedrockServer.start({ behaviorPacks: [pack], tickingArea: false });
    try {
      const line = await bds.waitForLog(l => l.includes("RUNTIME_LOAD "), 60_000, "runtime load");
      const measurement = JSON.parse(line.slice(line.indexOf("RUNTIME_LOAD ") + 13));
      expect(measurement.ok).toBe(true);
      expect(measurement.mappingKeys).toBeGreaterThan(0);
      runs.push({ ...measurement, startToParseMs: measurement.end - start });
    } finally { await bds.stop(); }
  }
  const sizes = Object.fromEntries(["main.js", "data.js", "parser.js", "arguments.js", "reader.js", "snbt.js"].map(name => [name, statSync(join(pack, "scripts", name)).size]));
  writeFileSync(join(paths.servers, "runtime-load-results.json"), JSON.stringify({ sizes, runs }, null, 2));
  expect(readFileSync(join(pack, "scripts/data.js")).length).toBeGreaterThan(0);
});
