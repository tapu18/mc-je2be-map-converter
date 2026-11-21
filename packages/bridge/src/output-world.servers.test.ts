import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { INIT_LOG_MARK } from "@je2be/converter";
import { nbt, readBedrockLevelDat, writeBedrockLevelDat } from "@je2be/core";
import { BedrockServer } from "./bedrock.ts";
import { buildConvertedWorld } from "./scenario/run.ts";
import { loadScenarios } from "./scenario/load.ts";
import { paths } from "./paths.ts";

it("initializes converted scores without repairing world settings or loading chunks", async () => {
  const scenario = loadScenarios().find(s => s.id === "convert/scores-chain")!;
  const converted = await buildConvertedWorld(scenario, []);
  try {
    const root = readBedrockLevelDat(new Uint8Array(readFileSync(join(converted.world, "level.dat")))).root.tag.value;
    const experiments = root.get("experiments");
    expect(experiments?.type === "compound" && experiments.value.get("gametest")?.value).toBe(1);
    for (const key of ["cheatsEnabled", "commandsEnabled", "commandblocksenabled"]) expect(root.get(key)?.value).toBe(1);
    let bds = await BedrockServer.start({ world: converted.world, worldSettings: "preserve", tickingArea: false, bridgeReadyTimeoutMs: 5000 });
    try {
      await bds.waitForLog(l => l.includes(INIT_LOG_MARK), 5000, "generated init pack");
      const scores = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
      expect(scores.result?.find(o => o.objective === "t")?.scores.find(s => s.participant === "kept")?.score).toBe(42);
      bds.console("tickingarea list all-dimensions");
      await bds.waitForLog(l => /No ticking areas exist/i.test(l), 3000, "no observation ticking areas");
      expect((await bds.exec("scoreboard players set kept t 99")).ok).toBe(true);
      bds = await bds.restart();
      const after = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
      expect(after.result?.find(o => o.objective === "t")?.scores.find(s => s.participant === "kept")?.score).toBe(99);
      expect(bds.log.some(l => l.includes(INIT_LOG_MARK))).toBe(false);
    } finally { await bds.stop(); }

    // 観測パックが元の初期化パックの不足を補わないことを確かめる。
    const missing = join(converted.work, "without-init");
    cpSync(converted.world, missing, { recursive: true });
    writeFileSync(join(missing, "world_behavior_packs.json"), "[]");
    const noInit = await BedrockServer.start({ world: missing, worldSettings: "preserve", tickingArea: false });
    try {
      expect((await noInit.request<unknown[]>("scores")).result).toEqual([]);
      expect(noInit.log.some(l => l.includes(INIT_LOG_MARK))).toBe(false);
    } finally { await noInit.stop(); }

    // 設定の欠落を従来のテスト用補助で修復してしまわないことも実測する。
    const file = join(converted.world, "level.dat");
    const dat = readBedrockLevelDat(new Uint8Array(readFileSync(file)));
    const exp = dat.root.tag.value.get("experiments");
    if (exp?.type !== "compound") throw new Error("missing generated experiments");
    exp.value.set("gametest", nbt.byte(0));
    writeFileSync(file, writeBedrockLevelDat(dat));
    await expect(BedrockServer.start({ world: converted.world, worldSettings: "preserve", tickingArea: false, bridgeReadyTimeoutMs: 3000 })).rejects.toThrow(/bridge pack ready/);
    const failedLog = readFileSync(join(paths.servers, "bedrock-last.log"), "utf8");
    expect(failedLog).toContain("Beta APIs experiment is not enabled");
  } finally { rmSync(converted.work, { recursive: true, force: true }); }
});
