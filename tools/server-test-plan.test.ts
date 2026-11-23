import { describe, expect, it } from "vitest";
import { planServerTests } from "./server-test-plan.ts";

const scenarioSuite = "packages/bridge/src/scenario/scenarios.servers.test.ts";
const bridge = "packages/bridge/src/bridge.servers.test.ts";
const launcher = "poc/launcher/launcher.servers.test.ts";
const dimension = "poc/launcher/dimension.servers.test.ts";
const performance = "poc/repeat-performance/performance.servers.test.ts";
const groups = { scenarios: [scenarioSuite], bridge: [bridge], "poc-a": [dimension], misc: [launcher], performance: [performance] };
const empty = { files: {}, scenarios: {} };

describe("server-test matrix", () => {
  it("selects the changed scenario and the test files for one PoC family across groups", () => {
    const jobs = planServerTests(groups, ["scores/a", "scores/ab"], [
      "scenarios/scores/a.java.json", "poc/launcher/pack/manifest.json", "docs/workflow.md",
    ], false, empty);
    expect(jobs.flatMap(({ files }) => files)).toEqual([dimension, launcher, scenarioSuite]);
    expect(jobs.flatMap(({ scenarios }) => scenarios)).toEqual(["scores/a"]);
  });

  it("skips docs-only changes and selects everything for shared or unknown paths", () => {
    expect(planServerTests(groups, ["scores/a"], ["docs/workflow.md", "README.md"], false, empty)).toEqual([]);
    for (const changed of [undefined, ["packages/core/src/index.ts"], [".github/workflows/ci.yml"], ["poc/shared/new.ts"]]) {
      const jobs = planServerTests(groups, ["scores/a"], changed, false, empty);
      expect(jobs.flatMap(({ files }) => files)).toEqual([bridge, dimension, launcher, performance, scenarioSuite]);
    }
  });

  it("shards 150 scenarios without omitting or duplicating any IDs", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `scores/${i}`);
    const jobs = planServerTests(groups, ids, undefined, false, empty).filter(({ group }) => group === "scenarios");
    expect(jobs).toHaveLength(13);
    expect(Math.max(...jobs.map(({ scenarios }) => scenarios.length))).toBe(12);
    expect(jobs.flatMap(({ scenarios }) => scenarios)).toEqual(ids);
  });

  it("runs quarantined files and scenarios only in isolated nightly jobs", () => {
    const quarantine = { files: { [bridge]: 108 }, scenarios: { "scores/a": 108 } };
    const active = planServerTests(groups, ["scores/a", "scores/b"], undefined, false, quarantine);
    const nightly = planServerTests(groups, ["scores/a", "scores/b"], undefined, true, quarantine);
    expect(active.flatMap(({ files }) => files)).not.toContain(bridge);
    expect(active.flatMap(({ scenarios }) => scenarios)).toEqual(["scores/b"]);
    expect(nightly.filter(({ quarantine: isolated }) => !isolated)).toEqual(active);
    const isolated = nightly.filter(({ quarantine: isolated }) => isolated);
    expect(isolated.flatMap(({ files }) => files)).toEqual([bridge, scenarioSuite]);
    expect(isolated.flatMap(({ scenarios }) => scenarios)).toEqual(["scores/a"]);
    expect(() => planServerTests(groups, ["scores/a"], undefined, true, { ...quarantine, files: { missing: 108 } })).toThrow(/Invalid quarantine entry/);
  });
});
