// tick内の実行順のPoC（docs/design.md 7章チェックリスト8項目目、#3）。
// tick.json の関数、system.runInterval、system.run、リピートコマンドブロック、scriptevent の順序を記録する。
// 結果は poc/tick-order/results.json に書き出す（根拠としてコミットする）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMcstructure, commandBlock, type StructureBlock } from "@je2be/core";
import { BedrockServer, JavaServer } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, "pack");
const RECORD_TICKS = 20;

function buildStructure(): Uint8Array {
  const repeat = (pos: [number, number, number], command: string, name: string): StructureBlock =>
    commandBlock({ pos, kind: "repeat", command, facing: 3, alwaysActive: true, customName: name });
  const blocks: StructureBlock[] = [
    // 構造物内の並び（x の小さい順）と、記録上の順序が一致するかを見るため、名前に x を入れる
    repeat([0, 0, 0], "je2be:mark repeat_x0", "x0"),
    repeat([4, 0, 0], "je2be:mark repeat_x4", "x4"),
    repeat([8, 0, 0], "je2be:mark repeat_x8_head", "x8"),
    commandBlock({ pos: [8, 0, 1], kind: "chain", command: "je2be:mark repeat_x8_chain", facing: 3, alwaysActive: true }),
    repeat([12, 0, 0], "scriptevent je2be:mark repeat_x12", "x12"),
  ];
  return buildMcstructure({ size: [13, 1, 2], blocks, fillAir: true });
}

interface Mark {
  tick: number;
  seq: number;
  source: string;
}

describe("tick order poc", () => {
  let bds: BedrockServer;
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    mkdirSync(join(packDir, "structures", "je2be"), { recursive: true });
    writeFileSync(join(packDir, "structures", "je2be", "tick_order.mcstructure"), buildStructure());
    bds = await BedrockServer.start({ behaviorPacks: [packDir] });
  });

  afterAll(async () => {
    writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");
    await bds?.stop();
  });

  it("records the order of execution sources within a tick", async () => {
    expect((await bds.exec("structure load je2be:tick_order 0 -50 0")).result?.successCount).toBe(1);
    // リピートブロックが動き始めるまで少し待ってから記録する
    await new Promise((r) => setTimeout(r, 1000));
    bds.console(`scriptevent je2be:start ${RECORD_TICKS}`);
    const deadline = Date.now() + 30_000;
    while (!bds.log.some((l) => l.includes("POC_DONE"))) {
      if (Date.now() > deadline) throw new Error("recording did not finish");
      await new Promise((r) => setTimeout(r, 100));
    }

    const marks: Mark[] = bds.log.flatMap((l) => {
      const i = l.indexOf("POC {");
      return i >= 0 ? [JSON.parse(l.slice(i + 4)) as Mark] : [];
    });
    const byTick = new Map<number, string[]>();
    for (const m of marks.sort((a, b) => a.seq - b.seq)) {
      const arr = byTick.get(m.tick) ?? [];
      arr.push(m.source);
      byTick.set(m.tick, arr);
    }
    // 記録の最初と最後のtickは途中から・途中までになるため除く
    const ticks = [...byTick.keys()].sort((a, b) => a - b).slice(1, -1);
    const orders = ticks.map((t) => byTick.get(t)!.join(" > "));
    const distinct = [...new Set(orders)];
    results.recordedTicks = ticks.length;
    results.distinctOrders = distinct.map((o) => ({ order: o.split(" > "), ticks: orders.filter((x) => x === o).length }));
    // 記録開始（scriptevent je2be:start のハンドラ）の直後から並べた生データ。tickの区切りの位置を推定する手がかり
    results.firstMarks = marks.slice(0, 18).map((m) => `${m.tick - marks[0]!.tick}:${m.source}`);
    results.contentLog = bds.log.filter((l) => /ERROR|WARN/.test(l));

    expect(ticks.length).toBeGreaterThanOrEqual(RECORD_TICKS - 3);
    expect(results.contentLog).toEqual([]);

    // ---- 実測で確かめた事実（BE更新で変わったらここで気づく） ----
    // 毎tick同じ順序。コマンドブロック → tick.json の関数（記載順） → runInterval → system.run（runInterval 内で積んだものが先） → scriptevent のハンドラ
    expect(distinct).toEqual([
      [
        "repeat_x0", "repeat_x4", "repeat_x8_head", "repeat_x8_chain",
        "function_a", "function_b",
        "runInterval", "runInterval.system_run",
        "repeat_x0.system_run", "repeat_x4.system_run", "repeat_x8_head.system_run", "repeat_x8_chain.system_run",
        "function_a.system_run", "function_b.system_run",
        "scriptevent:repeat_x12",
      ].join(" > "),
    ]);
    // tick の区切りは scriptevent のハンドラの後：開始の合図と同じtickに scriptevent だけが記録され、次のtickはコマンドブロックから始まる
    expect((results.firstMarks as string[]).slice(0, 2)).toEqual(["0:scriptevent:repeat_x12", "1:repeat_x0"]);
  });
});

// Java版の同じ観測。scriptevent や system.run に当たるものはないため、リピートコマンドブロックと tick 関数だけを比べる。
// 置いた順と座標の順のどちらで決まるかを見るため、x8 → x0 → x4 の順に置く。
describe("tick order poc (java)", () => {
  let java: JavaServer;
  const results: Record<string, unknown> = {};
  const JAVA_TICKS = 10;

  beforeAll(async () => {
    java = await JavaServer.start({ datapacks: [join(here, "datapack", "je2be_poc_tick")] });
  });

  afterAll(async () => {
    writeFileSync(join(here, "results.java.json"), JSON.stringify(results, null, 2) + "\n");
    await java?.stop();
  });

  it("records the order of execution sources within a tick", async () => {
    expect(java.log.some((l) => l.includes("POC_LOADED"))).toBe(true);
    const cmd = (name: string): string => `execute if score #rec t matches 1.. run function poc:mark {s:"${name}"}`;
    const place = async (pos: string, block: string, command: string): Promise<void> => {
      const res = await java.exec(`setblock ${pos} minecraft:${block}[facing=south]{Command:'${command}',auto:1b}`);
      expect(res).toMatch(/Changed the block/);
    };
    await place("8 -50 0", "repeating_command_block", cmd("repeat_x8_head"));
    await place("8 -50 1", "chain_command_block", cmd("repeat_x8_chain"));
    await place("0 -50 0", "repeating_command_block", cmd("repeat_x0"));
    await place("4 -50 0", "repeating_command_block", cmd("repeat_x4"));
    await new Promise((r) => setTimeout(r, 1000));

    await java.exec(`scoreboard players set #rec t ${JAVA_TICKS}`);
    await new Promise((r) => setTimeout(r, JAVA_TICKS * 50 + 1000));
    const text = await java.exec("data get storage poc:o list");
    const marks = [...text.matchAll(/\{s: "([^"]+)", t: (\d+)\}/g)].map((m) => ({ source: m[1]!, tick: Number(m[2]) }));
    const byTick = new Map<number, string[]>();
    for (const m of marks) byTick.set(m.tick, [...(byTick.get(m.tick) ?? []), m.source]);
    const ticks = [...byTick.keys()].sort((a, b) => a - b).slice(1, -1);
    const orders = ticks.map((t) => byTick.get(t)!.join(" > "));
    results.recordedTicks = ticks.length;
    results.distinctOrders = [...new Set(orders)].map((o) => ({ order: o.split(" > "), ticks: orders.filter((x) => x === o).length }));
    // RCONで #rec を設定した直後から並べた生データ（gametime は先頭からの差）
    results.firstMarks = marks.slice(0, 12).map((m) => `${m.tick - marks[0]!.tick}:${m.source}`);
    results.lastMarks = marks.slice(-6).map((m) => `${m.tick - marks[0]!.tick}:${m.source}`);
    expect(ticks.length).toBeGreaterThanOrEqual(JAVA_TICKS - 3);

    // ---- 実測で確かめた事実 ----
    // リピートブロックは座標順ではなく置いた順（x8 → x0 → x4）。関数とコマンドブロックが交互に動く
    expect(orders.every((o) => o === "repeat_x8_head > repeat_x8_chain > repeat_x0 > repeat_x4 > function_a > function_b")).toBe(true);
    // RCON の直後は tick 関数から始まり、gametime はコマンドブロックの前で増える。
    // RCON がtickの合間に処理されるとすれば、1tick は「tick 関数 → コマンドブロック」（BEとは逆）
    expect((results.firstMarks as string[]).slice(0, 3)).toEqual(["0:function_a", "0:function_b", "1:repeat_x8_head"]);
  });
});
