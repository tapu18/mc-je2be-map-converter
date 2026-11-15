// #18: リピートコマンドブロックの実行順を決めるもの（置いた順か、座標か、チャンクの読み込み順か）。
// 置いた順と座標順をずらし、複数のチャンクにまたがって置く。再起動の前後で記録する。
// poc/tick-order のパック（je2be:mark）とデータパック（poc:mark）を使う。
// 結果は poc/tick-order/results.cb-order.json に書き出す。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildMcstructure, commandBlock } from "@je2be/core";
import { BedrockServer, JavaServer, jsonLines, relativeOrder as relative, tickOrders, waitForLog, writeStructure, type TickMark, type TickOrders as OrderSummary } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, "pack");
const Y = -50;

// 置く順。チャンクは x=4,8 が 0、x=20 が 1、x=40 が 2。
// 同じチャンク内でも置いた順と座標順をずらす（x8 を x4 より先に置く）
const placements = [
  { name: "x20_c1", x: 20, z: 3 },
  { name: "x8_c0", x: 8, z: 3 },
  { name: "x40_c2", x: 40, z: 3 },
  { name: "x4_c0", x: 4, z: 3 },
];
const RECORD_TICKS = 40;
const results: Record<string, unknown> = { placementOrder: placements.map((p) => p.name) };

afterAll(() => {
  writeFileSync(join(here, "results.cb-order.json"), JSON.stringify(results, null, 2) + "\n");
});

/** コマンドブロックの記録だけを数える（system.run の記録は除く） */
const cbOnly = (src: string): boolean => src.startsWith("cb_") && !src.endsWith(".system_run");

describe("cb order (bedrock)", () => {
  let bds: BedrockServer;
  afterAll(async () => { await bds?.stop(); });

  const record = async (): Promise<OrderSummary> => {
    const from = bds.log.length;
    bds.console(`scriptevent je2be:start ${RECORD_TICKS}`);
    await waitForLog(bds.log, (l) => l.includes("POC_DONE"), 30_000, from);
    return tickOrders(jsonLines<TickMark>(bds.log, "POC", from), cbOnly);
  };

  it("records before and after restart", async () => {
    for (const p of placements) {
      const cb = commandBlock({ pos: [0, 0, 0], kind: "repeat", command: `je2be:mark cb_${p.name}`, facing: 3, alwaysActive: true });
      writeStructure(packDir, `cb_${p.name}`, buildMcstructure({ size: [1, 1, 1], blocks: [cb] }));
    }
    bds = await BedrockServer.start({ behaviorPacks: [packDir] });
    for (const p of placements) {
      expect((await bds.exec(`structure load je2be:cb_${p.name} ${p.x} ${Y} ${p.z}`)).result?.successCount).toBe(1);
      // 置いた順がはっきり分かれるよう、1つずつ間を空ける
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 500));
    const before = await record();
    bds = await bds.restart();
    await new Promise((r) => setTimeout(r, 1000));
    const after = await record();
    results.bedrock = { before, after, withinChunk0: { before: relative(before, "cb_x4_c0", "cb_x8_c0"), after: relative(after, "cb_x4_c0", "cb_x8_c0") } };
    expect(before.ticks).toBeGreaterThanOrEqual(RECORD_TICKS - 3);
    // ---- 実測で確かめた事実 ----
    // 同じチャンク内は置いた順（x8 → x4）。座標順ではない。再起動後も同じ
    expect(results.bedrock).toMatchObject({ withinChunk0: { before: "after", after: "after" } });
    // チャンク間の順序はtickによって入れ替わることがある（38tick中1〜2回）。ここでは固定しない
  });
});

describe("cb order (java)", () => {
  let java: JavaServer;
  afterAll(async () => { await java?.stop(); });

  const record = async (): Promise<OrderSummary> => {
    await java.exec("data remove storage poc:o list");
    await java.exec(`scoreboard players set #rec t ${RECORD_TICKS}`);
    await new Promise((r) => setTimeout(r, RECORD_TICKS * 50 + 1000));
    const text = await java.exec("data get storage poc:o list");
    const seq = [...text.matchAll(/\{s: "([^"]+)", t: (\d+)\}/g)]
      .map((m) => ({ source: m[1]!, tick: Number(m[2]) }))
      .filter((m) => m.source.startsWith("cb_"));
    return tickOrders(seq, cbOnly);
  };

  it("records before and after restart", async () => {
    java = await JavaServer.start({ datapacks: [join(here, "datapack", "je2be_poc_tick")] });
    for (const p of placements) {
      const cmd = `execute if score #rec t matches 1.. run function poc:mark {s:"cb_${p.name}"}`;
      expect(await java.exec(`setblock ${p.x} ${Y} ${p.z} minecraft:repeating_command_block[facing=south]{Command:'${cmd}',auto:1b}`)).toMatch(/Changed/);
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 500));
    const before = await record();
    java = await java.restart();
    await new Promise((r) => setTimeout(r, 1000));
    const after = await record();
    results.java = { before, after, withinChunk0: { before: relative(before, "cb_x4_c0", "cb_x8_c0"), after: relative(after, "cb_x4_c0", "cb_x8_c0") } };
    expect(before.ticks).toBeGreaterThanOrEqual(RECORD_TICKS - 3);
    // ---- 実測で確かめた事実 ----
    // 置いた直後は置いた順で、毎tick同じ
    expect(before.orders).toEqual([{ order: placements.map((p) => `cb_${p.name}`), count: before.ticks }]);
    // 再起動後も毎tick同じ順序。同じチャンク内は置いた順（x8 → x4）。チャンクの順は再起動ごとに変わり得るので固定しない
    expect(after.orders).toHaveLength(1);
    expect(results.java).toMatchObject({ withinChunk0: { before: "after", after: "after" } });
  });
});
