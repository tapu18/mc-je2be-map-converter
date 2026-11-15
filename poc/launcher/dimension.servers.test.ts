// #8: execute in <別ディメンション> を挟むとカスタムコマンドのハンドラが呼ばれない原因の切り分け。
// poc/launcher のパック（je2be:ctx、je2be:ctxarg、scriptevent je2be:ev）を使う。
// 結果は poc/launcher/results.dimension.json に書き出す。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMcstructure, commandBlock, type StructureBlock } from "@je2be/core";
import { BedrockServer, JavaServer } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, "pack");

/** 各行：先頭のインパルス（常時実行）で対象のコマンド、次の条件付きチェーンで成否を記録する */
const cases = (p: string): { label: string; command: string }[] => [
  { label: `${p}_ow`, command: `execute in overworld run je2be:ctx ${p}_ow` },
  // Java のID（the_nether）は BE では構文エラーになる
  { label: `${p}_javaid`, command: `execute in the_nether run je2be:ctx ${p}_javaid` },
  { label: `${p}_javaid_native`, command: `execute in the_nether run scoreboard players set ${p}_javaid_native_ran t 1` },
  { label: `${p}_ctx`, command: `execute in nether run je2be:ctx ${p}_ctx` },
  { label: `${p}_arg`, command: `execute in nether run je2be:ctxarg ${p}_arg ~ ~ ~` },
  { label: `${p}_pos`, command: `execute in nether positioned 3 70 3 run je2be:ctxarg ${p}_pos ~ ~ ~` },
  { label: `${p}_se`, command: `execute in nether run scriptevent je2be:ev ${p}_se` },
  { label: `${p}_native`, command: `execute in nether run scoreboard players set ${p}_native_ran t 1` },
  { label: `${p}_end`, command: `execute in the_end run je2be:ctx ${p}_end` },
];

function buildStructure(prefix: string): Uint8Array {
  const blocks: StructureBlock[] = [];
  cases(prefix).forEach((c, i) => {
    blocks.push(commandBlock({ pos: [i * 2, 0, 0], kind: "impulse", command: c.command, facing: 3, alwaysActive: true }));
    blocks.push(
      commandBlock({ pos: [i * 2, 0, 1], kind: "chain", command: `scoreboard players set ok_${c.label} t 1`, facing: 3, conditional: true, alwaysActive: true }),
    );
  });
  return buildMcstructure({ size: [cases(prefix).length * 2, 1, 2], blocks, fillAir: true });
}

interface PocLog {
  event: string;
  label?: string;
  [k: string]: unknown;
}

describe("dimension poc", () => {
  let bds: BedrockServer;
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    mkdirSync(join(packDir, "structures", "je2be"), { recursive: true });
    for (const p of ["a", "b"]) writeFileSync(join(packDir, "structures", "je2be", `dim_${p}.mcstructure`), buildStructure(p));
    bds = await BedrockServer.start({ behaviorPacks: [packDir] });
  });

  afterAll(async () => {
    writeFileSync(join(here, "results.dimension.json"), JSON.stringify(results, null, 2) + "\n");
    await bds?.stop();
  });

  const logs = (): PocLog[] =>
    bds.log.flatMap((l) => {
      const i = l.indexOf("POC {");
      return i >= 0 ? [JSON.parse(l.slice(i + 4)) as PocLog] : [];
    });

  const summarize = async (prefix: string): Promise<Record<string, unknown>> => {
    const scores = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
    const t = new Set((scores.result?.find((o) => o.objective === "t")?.scores ?? []).map((s) => s.participant));
    const out: Record<string, unknown> = {};
    for (const c of cases(prefix)) {
      const handled = logs().find((l) => l.label === c.label);
      out[c.label] = {
        command: c.command,
        succeeded: t.has(`ok_${c.label}`),
        handlerCalled: handled !== undefined,
        ...(handled ? { pos: handled.pos, origin: handled.origin, sourceType: handled.sourceType } : {}),
        ...(c.label.endsWith("_native") ? { nativeRan: t.has(`${c.label}_ran`) } : {}),
      };
    }
    return out;
  };

  it("compares unloaded and loaded nether chunks", async () => {
    expect((await bds.exec("scoreboard objectives add t dummy")).result?.successCount).toBe(1);

    // A: ネザー側のチャンクを読み込んでいない状態
    expect((await bds.exec("structure load je2be:dim_a 0 -50 0")).result?.successCount).toBe(1);
    await new Promise((r) => setTimeout(r, 2000));
    results.unloaded = await summarize("a");

    // B: ネザー側にも同じ範囲の ticking area を置いた状態
    results.netherTickingArea = await bds.exec("tickingarea add 0 0 0 63 0 63 je2be_nether", "nether");
    const deadline = Date.now() + 30_000;
    while (!(await bds.request<boolean>("loaded", { pos: [0, 64, 0], dimension: "nether" })).result) {
      if (Date.now() > deadline) throw new Error("nether ticking area did not load");
      await new Promise((r) => setTimeout(r, 250));
    }
    expect((await bds.exec("structure load je2be:dim_b 0 -50 10")).result?.successCount).toBe(1);
    await new Promise((r) => setTimeout(r, 2000));
    results.netherLoaded = await summarize("b");

    // スクリプト（オーバーワールドの runCommand）から直接呼んだ場合
    results.fromScript = {
      unloadedEnd: await bds.exec("execute in the_end run je2be:ctx c_end"),
      javaId: await bds.exec("execute in the_nether run je2be:ctx c_javaid"),
      loadedNether: await bds.exec("execute in nether run je2be:ctx c_nether"),
    };
    await new Promise((r) => setTimeout(r, 500));
    results.fromScriptHandled = logs().filter((l) => l.label?.startsWith("c_")).map((l) => l.label);
    results.contentLog = bds.log.filter((l) => /ERROR|WARN/.test(l));

    // ---- 実測で確かめた事実 ----
    type Case = { succeeded: boolean; handlerCalled: boolean; pos?: { x: number; y: number; z: number }; nativeRan?: boolean; origin?: unknown };
    for (const [key, p] of [["unloaded", "a"], ["netherLoaded", "b"]] as const) {
      const r = results[key] as Record<string, Case>;
      // Java のID the_nether は BE では構文エラー（BEコマンドも同じ）。BEでは nether
      expect(r[`${p}_javaid`]).toMatchObject({ succeeded: false, handlerCalled: false });
      expect(r[`${p}_javaid_native`]).toMatchObject({ succeeded: false, nativeRan: false });
      // nether なら、チャンクの読み込みの有無にかかわらず動く
      for (const c of ["ctx", "arg", "pos", "se", "end"]) expect(r[`${p}_${c}`]).toMatchObject({ succeeded: true, handlerCalled: true });
      expect(r[`${p}_native`]).toMatchObject({ succeeded: true, nativeRan: true });
      // 発生元からはディメンションがわからない（sourceType は Server、sourceBlock なし）
      expect(r[`${p}_ctx`]!.origin).toMatchObject({ sourceType: "Server", sourceBlock: null });
      expect(r[`${p}_pos`]!.pos).toEqual({ x: 3.5, y: 70, z: 3.5 });
    }
    // execute in nether は x・z を 1/8 にする（y はそのまま）。コマンドブロックは x=8 の列、z=0（A）と z=10（B）
    expect((results.unloaded as Record<string, Case>).a_arg!.pos).toEqual({ x: 8.5 / 8, y: -49.5, z: 0.5 / 8 });
    expect((results.netherLoaded as Record<string, Case>).b_arg!.pos).toEqual({ x: 8.5 / 8, y: -49.5, z: 10.5 / 8 });
    expect(results.contentLog).toEqual([]);
  });
});

describe("dimension poc (java)", () => {
  let java: JavaServer;
  const results: Record<string, string> = {};
  beforeAll(async () => { java = await JavaServer.start(); });
  afterAll(async () => {
    writeFileSync(join(here, "results.dimension.java.json"), JSON.stringify(results, null, 2) + "\n");
    await java?.stop();
  });

  it("scales x/z by 1/8 and uses the_nether as the id", async () => {
    await java.exec("execute in minecraft:the_nether run forceload add 0 0 100 100");
    await new Promise((r) => setTimeout(r, 3000));
    results.summon = await java.exec('execute positioned 80.5 70 16.5 in minecraft:the_nether run summon minecraft:marker ~ ~ ~ {Tags:["m"]}');
    results.pos = await java.exec("execute in minecraft:the_nether run data get entity @e[tag=m,limit=1] Pos");
    results.bedrockId = await java.exec("execute in nether run say x");
    // Java も execute in で x・z を 1/8 にする（y はそのまま）。BEと同じ
    expect(results.pos).toMatch(/\[10\.0625d, 70\.0d, 2\.0625d\]/);
    expect(results.bedrockId).toMatch(/Unknown dimension 'minecraft:nether'/);
  });
});
