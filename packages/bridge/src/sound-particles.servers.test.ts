import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MappingTables } from "@je2be/core";
import { BedrockServer } from "./bedrock.ts";
import { withSimulatedPlayer } from "./simulated-player.ts";
import { rewriteResources } from "./rewrite-resources.ts";
import { loadScenarios } from "./scenario/load.ts";
import { buildConvertedWorld } from "./scenario/run.ts";

// GameTest の試験用プレイヤーを対象にし、playsound の成功件数を観測する。
const withListener = (run: (bds: BedrockServer) => Promise<void>, world?: string) => withSimulatedPlayer("Listener", run, world);

describe("sound and particle output", () => {
  it("checks every distinct mapped ID and compares nonexistent IDs with syntax errors", async () => {
    const resources = await rewriteResources();
    const mappings = JSON.parse(readFileSync(resources.mappingsJson, "utf8")) as MappingTables;
    const sounds = [...new Set(Object.values(mappings.sounds!))];
    const particles = [...new Set(Object.values(mappings.particles!))];
    expect([sounds.length, particles.length]).toEqual([1615, 81]);

    await withListener(async (bds) => {
      const probes = [
        ...sounds.map((id) => `playsound ${id} Listener 8.5 -59 8.5`),
        ...particles.map((id) => `particle ${id} 8.5 -59 8.5`),
        "playsound je2be.nonexistent.sound Listener 8.5 -59 8.5",
        "particle minecraft:je2be_nonexistent_particle 8.5 -59 8.5",
        "particle geyseropt:ash 8.5 -59 8.5",
      ];
      const rejected: { command: string; result: unknown }[] = [];
      for (const command of probes) {
        const result = await bds.exec(command);
        if (!result.ok || result.result?.successCount !== 1) rejected.push({ command, result });
      }
      expect(rejected).toEqual([]);
      for (const command of [
        "playsound random.orb player Listener 8.5 -59 8.5",
        "particle minecraft:basic_flame_particle 8.5 -59 8.5 0 0 0 0 1 force",
      ]) {
        expect(await bds.exec(command), command).toMatchObject({ ok: false });
      }
    });
  });

  it("checks the distance, volume, pitch and minimum volume accepted by playsound", async () => {
    await withListener(async (bds) => {
      for (const [command, successCount] of [
        ["execute positioned 8.5 -59 8.5 run playsound random.orb Listener", 1],
        ["execute positioned 32.5 -59 8.5 run playsound random.orb Listener", 1],
        ["execute positioned 32.5 -59 8.5 run playsound random.orb Listener ~ ~ ~", 0],
        ["playsound random.orb Listener 32.5 -59 8.5 1 1 0", 0],
        ["playsound random.orb Listener 32.5 -59 8.5 2 1 0", 1],
        ["playsound random.orb Listener 32.5 -59 8.5 1 1 0.5", 1],
        ["playsound random.orb Listener 8.5 -59 8.5 1 0 0", 1],
        ["playsound random.orb Listener 8.5 -59 8.5 1 2 0", 1],
      ] as const) {
        expect(await bds.exec(command), command).toMatchObject({ ok: true, result: { successCount } });
      }
    });
  });

  it("checks converted scenario commands and loss reports against BDS", async () => {
    const scenario = loadScenarios().find((s) => s.id === "convert/sound-particles")!;
    const converted = await buildConvertedWorld(scenario, []);
    try {
      const entries = converted.report.commands!.commandBlocks;
      const entryAt = (x: number) => entries.find((entry) => entry.pos[0] === x)!;
      expect(converted.report.commands!.counts).toEqual({ rewritten: 2, unchanged: 2, invalid: 0, unsupported: 3 });
      expect(entryAt(2)).toMatchObject({
        status: "rewritten",
        bedrock: "playsound random.orb @p 2.5 -59 1.5 1.5 0.7 0.25",
        issues: [{ severity: "warning", message: expect.stringContaining("カテゴリ player") }, { severity: "warning" }],
      });
      expect(entryAt(6)).toMatchObject({
        status: "rewritten",
        bedrock: "particle minecraft:basic_flame_particle 6.5 -58.5 0.5",
        issues: [{ severity: "warning", message: expect.stringContaining("エミッター") }],
      });
      expect(entryAt(10)).toMatchObject({
        status: "unsupported", issues: [{ severity: "unsupported", message: expect.stringContaining("example:unmapped") }],
      });
      expect(entryAt(11)).toMatchObject({
        status: "unsupported",
        issues: [
          { severity: "unsupported", message: expect.stringContaining("minecraft:dust") },
          { severity: "unsupported", message: expect.stringMatching(/色.*delta.*speed.*count=3.*force.*viewers/) },
        ],
      });
      expect(entryAt(12)).toMatchObject({
        status: "unsupported", issues: [{ severity: "unsupported", message: expect.stringContaining("minecraft:elder_guardian") }],
      });
      await withListener(async (bds) => {
        for (const x of [2, 6]) {
          const command = entryAt(x).bedrock!;
          expect(await bds.exec(command), command).toMatchObject({ ok: true, result: { successCount: 1 } });
        }
      }, converted.world);
    } finally {
      rmSync(converted.work, { recursive: true, force: true });
    }
  });
});
