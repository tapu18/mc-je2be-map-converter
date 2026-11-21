import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { INIT_LOG_MARK } from "@je2be/converter";
import { expect, it } from "vitest";
import { BedrockServer } from "./bedrock.ts";
import { repoRoot } from "./paths.ts";
import { loadScenarios, readGolden } from "./scenario/load.ts";
import { normalizeBedrock, type RawEntity } from "./scenario/normalize.ts";
import { buildConvertedWorld } from "./scenario/run.ts";

interface PlacedObservation extends RawEntity {
  id: string;
  rot: [number, number];
  invisible: boolean;
  markVariant?: number;
  scale?: number;
  health?: number;
  components: string[];
}

it("restores placed entities before observation, preserves identities on reopen and reports omitted data", async () => {
  const scenario = loadScenarios().find((s) => s.id === "convert/placed-entities")!;
  const golden = readGolden(scenario)!;
  const { work, world, report } = await buildConvertedWorld(scenario, []);
  try {
    const { skipped, fields } = report.entities;
    expect(report.entities.scheduled).toBe(3);
    expect(skipped).toEqual([expect.objectContaining({ type: "minecraft:marker" })]);
    expect(report.scores.skipped).toEqual([expect.objectContaining({ participant: skipped[0]!.uuid })]);
    expect(fields.map((f) => f.field)).toEqual(expect.arrayContaining([
      "CustomNameVisible", "ShowArms", "Small", "Pose", "NoAI", "Invulnerable", "Silent", "VillagerData.level", "VillagerData.type", "Offers",
    ]));
    let bds = await BedrockServer.start({ world, worldSettings: "preserve", tickingArea: false });
    const observe = async (): Promise<PlacedObservation[]> => {
      const result = await bds.request<PlacedObservation[]>("entities", {
        query: { tags: ["je2be_placed"] }, scoreObjectives: ["entity_points"], components: true,
      });
      expect(result.ok, result.error).toBe(true);
      return result.result!;
    };
    try {
      const line = await bds.waitForLog((l) => l.includes(INIT_LOG_MARK), 30_000, "placed entities initialization");
      expect(line).toContain("3 entity placements, 0 entity errors");
      // ここで初めて観測範囲を読み込む。初期化のチャンク読み込みにはブリッジの補助が入らない。
      expect((await bds.exec("tickingarea add 0 -60 0 63 -60 63 placement_observe true")).ok).toBe(true);
      await expect.poll(async () => (await bds.request("loaded", { pos: [48, -60, 48] })).result, { timeout: 10_000 }).toBe(true);
      const before = await observe();
      expect(normalizeBedrock(scenario.observe, { entities: before })).toEqual(golden.state);
      const stand = before.find((e) => e.tags.includes("display_stand"))!;
      expect(stand.pos).toEqual([8.5, -60, 8.5]);
      expect(stand.rot).toEqual([0, 90]);
      expect(stand.invisible).toBe(true);
      expect((await bds.exec("testfor @e[tag=display_stand,hasitem={item=iron_helmet,location=slot.armor.head}]")).result?.successCount).toBe(1);
      const guide = before.find((e) => e.tags.includes("guide"))!;
      expect(guide.components).toContain("minecraft:navigation.walk");
      expect((await bds.exec("testfor @e[tag=guide,family=farmer]")).result?.successCount).toBe(1);
      expect(guide.markVariant ?? 0).toBe(0);
      expect(guide.components).not.toContain("minecraft:economy_trade_table");
      expect(stand.scale ?? 1).toBe(1);
      expect((await bds.exec("damage @e[tag=guide] 1")).result?.successCount).toBe(1);
      expect((await observe()).find((e) => e.tags.includes("guide"))?.health).toBeLessThan(guide.health!);
      bds = await bds.restart();
      await expect.poll(async () => (await bds.request("loaded", { pos: [48, -60, 48] })).result, { timeout: 10_000 }).toBe(true);
      const after = await observe();
      expect(normalizeBedrock(scenario.observe, { entities: after })).toEqual(golden.state);
      expect(after.find((e) => e.tags.includes("display_stand"))?.invisible).toBe(true);
      expect((await bds.exec("testfor @e[tag=guide,family=farmer]")).result?.successCount).toBe(1);
      expect(after.map((entity) => entity.id).sort()).toEqual(before.map((entity) => entity.id).sort());
      expect(bds.log.some((l) => l.includes(INIT_LOG_MARK))).toBe(false);
    } finally {
      await bds.stop();
    }

    const artifacts = process.env.JE2BE_ACCEPTANCE_ARTIFACTS;
    if (artifacts) {
      mkdirSync(artifacts, { recursive: true });
      execFileSync(process.execPath, [join(repoRoot, "packages/converter/src/cli.ts"), "convert", join(work, "java"),
        "--out", join(artifacts, "placed-entities.mcworld")], { timeout: 600_000, stdio: "inherit" });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
