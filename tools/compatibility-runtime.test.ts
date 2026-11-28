import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runtimeScenarioLines, runtimeScenarios, type RuntimeScenario } from "./compatibility-runtime.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const scenario = (id: string, test: string): RuntimeScenario => ({ id, test, lines: s => s.setup });

describe("runtime scenario evidence for the compatibility ledger", () => {
  it("points every listed scenario at an existing scenario and test on this checkout", () => {
    const read = runtimeScenarioLines(root);
    expect(read.map(entry => entry.id)).toEqual(runtimeScenarios.map(entry => entry.id));
    for (const { source, lines } of read) {
      expect(source).toMatch(/^scenarios\/datapack\/[\w-]+\.json; packages\/[\w-]+\/src\/[\w.-]+\.test\.ts$/);
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  it("fails when a test was renamed, no longer names the scenario, or the scenario is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-runtime-"));
    try {
      mkdirSync(join(dir, "scenarios/datapack"), { recursive: true });
      writeFileSync(join(dir, "scenarios/datapack/demo.json"), JSON.stringify({ setup: ["say hi"], actions: [] }));
      writeFileSync(join(dir, "demo.data.test.ts"), `it.each(["demo"])`);
      writeFileSync(join(dir, "other.data.test.ts"), `it.each(["other"])`);
      expect(runtimeScenarioLines(dir, [scenario("demo", "demo.data.test.ts")]))
        .toEqual([{ id: "demo", source: "scenarios/datapack/demo.json; demo.data.test.ts", lines: ["say hi"] }]);
      expect(() => runtimeScenarioLines(dir, [scenario("demo", "demo.servers.test.ts")])).toThrow("does not exist");
      expect(() => runtimeScenarioLines(dir, [scenario("demo", "other.data.test.ts")])).toThrow("does not name the scenario");
      writeFileSync(join(dir, "other.data.test.ts"), `it.each(["gone"])`);
      expect(() => runtimeScenarioLines(dir, [scenario("gone", "other.data.test.ts")])).toThrow("gone.json does not exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
