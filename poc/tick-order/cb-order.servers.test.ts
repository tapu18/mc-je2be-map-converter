// #18: リピートコマンドブロックの実行順を決めるもの（置いた順か、座標か、チャンクの読み込み順か）。
// 置いた順と座標順をずらし、複数のチャンクにまたがって置く。再起動の前後で記録する。
// poc/tick-order のパック（je2be:mark）とデータパック（poc:mark）を使う。
// 結果は poc/tick-order/results.cb-order.json に書き出す。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildMcstructure, commandBlock } from "@je2be/core";
import { BedrockServer, JavaServer } from "@je2be/bridge";

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

/** 1tick分の並びを取り出し、何tick分あっても同じかを確かめる */
interface OrderSummary {
  ticks: number;
  /** 出てきた並びと、その回数（多い順） */
  orders: { order: string[]; count: number }[];
}

/** tickごとの並びを集計する（system.run の記録は除く） */
function orderOf(seq: { tick: number; source: string }[]): OrderSummary {
  const byTick = new Map<number, string[]>();
  for (const m of seq) {
    if (m.source.endsWith(".system_run")) continue;
    byTick.set(m.tick, [...(byTick.get(m.tick) ?? []), m.source]);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b).slice(1, -1);
  const counts = new Map<string, number>();
  for (const t of ticks) {
    const k = byTick.get(t)!.join(",");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const orders = [...counts].sort((a, b) => b[1] - a[1]).map(([k, count]) => ({ order: k.split(","), count }));
  return { ticks: ticks.length, orders };
}

/** 並びの中での a と b の前後が、全tickで同じか */
function relative(summary: OrderSummary, a: string, b: string): "before" | "after" | "varies" {
  const rel = new Set(summary.orders.map((o) => (o.order.indexOf(a) < o.order.indexOf(b) ? "before" : "after")));
  return rel.size === 1 ? [...rel][0]! : "varies";
}

describe("cb order (bedrock)", () => {
  let bds: BedrockServer;
  afterAll(async () => { await bds?.stop(); });

  const record = async (): Promise<OrderSummary> => {
    const from = bds.log.length;
    bds.console(`scriptevent je2be:start ${RECORD_TICKS}`);
    const deadline = Date.now() + 30_000;
    while (!bds.log.slice(from).some((l) => l.includes("POC_DONE"))) {
      if (Date.now() > deadline) throw new Error("recording did not finish");
      await new Promise((r) => setTimeout(r, 100));
    }
    const seq = bds.log.slice(from).flatMap((l) => {
      const i = l.indexOf("POC {");
      if (i < 0) return [];
      const m = JSON.parse(l.slice(i + 4)) as { tick: number; source: string };
      return m.source.startsWith("cb_") ? [m] : [];
    });
    return orderOf(seq);
  };

  it("records before and after restart", async () => {
    const dir = join(packDir, "structures", "je2be");
    mkdirSync(dir, { recursive: true });
    for (const p of placements) {
      const cb = commandBlock({ pos: [0, 0, 0], kind: "repeat", command: `je2be:mark cb_${p.name}`, facing: 3, alwaysActive: true });
      writeFileSync(join(dir, `cb_${p.name}.mcstructure`), buildMcstructure({ size: [1, 1, 1], blocks: [cb] }));
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
    return orderOf(seq);
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
