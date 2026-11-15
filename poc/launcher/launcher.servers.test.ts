// 起動口のPoC（docs/design.md 7章チェックリスト3〜7項目目）。
// コマンドブロックを並べた .mcstructure を生成してBDSに読み込み、スコアとスクリプトのログから挙動を記録する。
// 結果は poc/launcher/results.json に書き出す（根拠としてコミットする）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMcstructure, commandBlock, type StructureBlock } from "@je2be/core";
import { BedrockServer } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, "pack");
const ORIGIN = [0, -50, 0] as const;

/** x列ごとに、+Z方向（南）へ並ぶチェーン。先頭はインパルス（常時実行＝読み込み時に1回）、以降はチェーン（常時実行） */
interface Row {
  name: string;
  blocks: { command: string; conditional?: boolean }[];
  /** 先頭ブロックの前後に比較器を置く（向きの規約が不明なため両側に置く） */
  comparators?: boolean;
}

const rows: Row[] = [
  { name: "native_fail", blocks: [{ command: "scoreboard players add nobody nope 1" }, { command: "scoreboard players set r_native_fail t 1", conditional: true }] },
  { name: "native_ok", blocks: [{ command: "scoreboard players set x t 1" }, { command: "scoreboard players set r_native_ok t 1", conditional: true }] },
  { name: "custom_ok", blocks: [{ command: "je2be:ok" }, { command: "scoreboard players set r_custom_ok t 1", conditional: true }] },
  { name: "custom_fail", blocks: [{ command: "je2be:fail" }, { command: "scoreboard players set r_custom_fail t 1", conditional: true }] },
  { name: "custom_void", blocks: [{ command: "je2be:void" }, { command: "scoreboard players set r_custom_void t 1", conditional: true }] },
  { name: "scriptevent", blocks: [{ command: "scriptevent je2be:ev se" }, { command: "scoreboard players set r_scriptevent t 1", conditional: true }] },
  {
    name: "chain_custom_fail",
    blocks: [{ command: "scoreboard players set x t 1" }, { command: "je2be:fail" }, { command: "scoreboard players set r_chain_custom_fail t 1", conditional: true }],
  },
  {
    name: "order_scriptevent",
    blocks: [
      { command: "scoreboard players set seq_ose t 1" },
      { command: "scriptevent je2be:ev ose" },
      { command: "scoreboard players set seq_ose t 2" },
      { command: "execute if score w_ose t matches 1 run scoreboard players set seen_ose t 1" },
    ],
  },
  {
    name: "order_custom",
    blocks: [
      { command: "scoreboard players set seq_ocu t 1" },
      { command: "je2be:probe ocu" },
      { command: "scoreboard players set seq_ocu t 2" },
      { command: "execute if score w_ocu t matches 1 run scoreboard players set seen_ocu t 1" },
    ],
  },
  { name: "restrict", blocks: [{ command: "je2be:restrict r" }, { command: "scriptevent je2be:ops r" }] },
  {
    name: "context",
    blocks: [
      { command: "execute positioned 7 8 9 run je2be:ctx pos" },
      { command: "execute in the_nether run je2be:ctx nether" },
      { command: "execute positioned 7 8 9 run scriptevent je2be:ev ctxse" },
    ],
  },
  {
    name: "context_args",
    blocks: [
      { command: "je2be:ctxarg direct ~ ~ ~ ^ ^ ^1" },
      { command: "execute positioned 7 8 9 run je2be:ctxarg positioned ~ ~ ~ ^ ^ ^1" },
      { command: "execute as @e[tag=ctx_stand] at @s run je2be:ctxarg as_at ~ ~ ~ ^ ^ ^1 @s" },
      { command: "execute positioned 7 8 9 rotated 90 0 run je2be:ctxarg rotated ~ ~ ~ ^ ^ ^1" },
      { command: "execute positioned 7 8 9 rotated 0 0 anchored eyes run je2be:ctxarg anchored ~ ~ ~ ^ ^ ^1" },
      { command: "execute in the_nether positioned 1 64 1 run je2be:ctxarg nether ~ ~ ~ ^ ^ ^1 @s" },
    ],
  },
  { name: "cmp_native_ok", comparators: true, blocks: [{ command: "scoreboard players set y t 1" }] },
  { name: "cmp_native_fail", comparators: true, blocks: [{ command: "scoreboard players add nobody nope 1" }] },
  { name: "cmp_custom_ok", comparators: true, blocks: [{ command: "je2be:ok" }] },
  { name: "cmp_custom_fail", comparators: true, blocks: [{ command: "je2be:fail" }] },
  { name: "cmp_scriptevent", comparators: true, blocks: [{ command: "scriptevent je2be:ev cmp" }] },
];

const COMPARATOR_STATES = { "minecraft:cardinal_direction": "south", direction: 0, output_lit_bit: false, output_subtract_bit: false };

function buildStructure(): Uint8Array {
  const blocks: StructureBlock[] = [];
  rows.forEach((row, i) => {
    const x = i * 2;
    // 比較器を置く行は z=1 にコマンドブロック、z=0 と z=2 に比較器（どちらかが入力側を向く）
    const z0 = row.comparators ? 1 : 0;
    row.blocks.forEach((b, j) => {
      blocks.push(
        commandBlock({
          pos: [x, 0, z0 + j],
          kind: j === 0 ? "impulse" : "chain",
          command: b.command,
          facing: row.comparators ? 0 : 3,
          conditional: b.conditional ?? false,
          alwaysActive: true,
          customName: `${row.name}#${j}`,
        }),
      );
    });
    if (row.comparators) {
      blocks.push({ pos: [x, 0, 0], name: "minecraft:unpowered_comparator", states: COMPARATOR_STATES });
      blocks.push({ pos: [x, 0, 2], name: "minecraft:unpowered_comparator", states: COMPARATOR_STATES });
    }
  });
  const depth = Math.max(...rows.map((r) => r.blocks.length + (r.comparators ? 2 : 0)));
  return buildMcstructure({ size: [rows.length * 2, 1, depth], blocks, fillAir: true });
}

interface PocLog {
  event: string;
  tick: number;
  [k: string]: unknown;
}

describe("launcher poc", () => {
  let bds: BedrockServer;
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    mkdirSync(join(packDir, "structures", "je2be"), { recursive: true });
    writeFileSync(join(packDir, "structures", "je2be", "launcher.mcstructure"), buildStructure());
    bds = await BedrockServer.start({ behaviorPacks: [packDir] });
  });

  afterAll(async () => {
    writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");
    await bds?.stop();
  });

  it("runs the experiments", async () => {
    // 比較器が浮かないよう、行の下に石を敷く
    await bds.exec(`fill ${ORIGIN[0]} ${ORIGIN[1] - 1} ${ORIGIN[2]} ${ORIGIN[0] + rows.length * 2} ${ORIGIN[1] - 1} ${ORIGIN[2] + 8} stone`);
    expect((await bds.exec("scoreboard objectives add t dummy")).result?.successCount).toBe(1);
    // 実行者として使うエンティティ（向きを付けて置く）
    await bds.exec("summon armor_stand 30.5 -60 40.5 45 0");
    await bds.exec("tag @e[type=armor_stand,x=30,y=-60,z=40,r=2] add ctx_stand");
    const startTick = (await bds.request<{ tick: number }>("ping")).result!.tick;
    const load = await bds.exec(`structure load je2be:launcher ${ORIGIN.join(" ")}`);
    results.structureLoad = load;
    expect(load.result?.successCount).toBe(1);
    await new Promise((r) => setTimeout(r, 3000));

    const scores = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
    const t = Object.fromEntries((scores.result?.find((o) => o.objective === "t")?.scores ?? []).map((s) => [s.participant, s.score]));
    results.scores = t;

    const logs = bds.log
      .map((l) => l.indexOf("POC "))
      .map((idx, i) => (idx >= 0 ? (JSON.parse(bds.log[i]!.slice(idx + 4)) as PocLog) : undefined))
      .filter((l): l is PocLog => l !== undefined && l.event !== "ready")
      .map((l) => ({ ...l, tick: l.tick - startTick }));
    results.logs = logs;

    const cmpRows = rows.map((r, i) => ({ r, x: ORIGIN[0] + i * 2 })).filter(({ r }) => r.comparators);
    const comparators: Record<string, unknown> = {};
    for (const { r, x } of cmpRows) {
      const res = await bds.request<{ pos: number[]; type: string; states: Record<string, unknown> }[]>("blocks", {
        from: [x, ORIGIN[1], ORIGIN[2]],
        to: [x, ORIGIN[1], ORIGIN[2] + 2],
      });
      comparators[r.name] = res.result?.map((b) => ({ z: b.pos[2], type: b.type, lit: b.states?.output_lit_bit }));
    }
    results.comparators = comparators;

    results.contentLog = bds.log.filter((l) => /\[Scripting\]|ERROR|WARN/.test(l) && !l.includes("JE2BE_") && !l.includes("POC "));

    // ---- 実測で確かめた事実（BE更新で変わったらここで気づく） ----
    const find = (event: string, label: string): PocLog | undefined => logs.find((l) => l.event === event && l.label === label);

    // 条件付きチェーンへの成否の伝搬：カスタムコマンドの Failure は止まる。undefined と scriptevent は成功扱い
    expect(t.r_native_fail).toBeUndefined();
    expect(t.r_native_ok).toBe(1);
    expect(t.r_custom_ok).toBe(1);
    expect(t.r_custom_fail).toBeUndefined();
    expect(t.r_chain_custom_fail).toBeUndefined();
    expect(t.r_custom_void).toBe(1);
    expect(t.r_scriptevent).toBe(1);

    // 比較器：成否どおりに出力する。cardinal_direction=south の比較器は南側（+Z）から入力を受ける
    const lit = (name: string): unknown[] => (comparators[name] as { lit?: boolean }[]).map((c) => c.lit);
    expect(lit("cmp_native_ok")).toEqual([true, undefined, false]);
    expect(lit("cmp_native_fail")).toEqual([false, undefined, false]);
    expect(lit("cmp_custom_ok")).toEqual([true, undefined, false]);
    expect(lit("cmp_custom_fail")).toEqual([false, undefined, false]);
    expect(lit("cmp_scriptevent")).toEqual([true, undefined, false]);

    // 実行順：カスタムコマンドのハンドラはチェーンの途中で同期実行。system.run と scriptevent はチェーンの後（同じtick）
    expect(find("probe.handler", "ocu")?.seq).toBe(1);
    expect(find("probe.deferred", "ocu")).toMatchObject({ seq: 2, successCount: 1, readBack: 1, tick: find("probe.handler", "ocu")?.tick });
    expect(t.seen_ocu).toBeUndefined();
    expect(find("scriptevent", "ose")?.seq).toBe(2);
    expect(t.seen_ose).toBeUndefined();

    // ハンドラ内の制限：読み取りと動的プロパティは可、ワールドの変更は不可。遅延実行と scriptevent では全て可
    const ops = (event: string): Record<string, { ok: boolean }> => find(event, "r")?.ops as Record<string, { ok: boolean }>;
    const okOf = (o: Record<string, { ok: boolean }>): Record<string, boolean> =>
      Object.fromEntries(Object.entries(o).filter(([k]) => k !== "readScore").map(([k, v]) => [k, v.ok]));
    expect(okOf(ops("restrict.handler"))).toEqual({
      writeScore: false, runCommand: false, getBlock: true, setBlock: false,
      getEntities: true, spawnEntity: false, setDynamicProperty: true, getDynamicProperty: true,
    });
    expect(Object.values(okOf(ops("restrict.deferred"))).every(Boolean)).toBe(true);
    expect(Object.values(okOf(ops("scriptevent.ops"))).every(Boolean)).toBe(true);

    // 実行コンテキスト：execute を挟むと sourceBlock は失われるが、引数の ~ ~ ~ / ^ ^ ^1 / @s で復元できる
    expect(find("ctx.custom", "pos")?.origin).toMatchObject({ sourceType: "Server", sourceBlock: null });
    expect(find("scriptevent", "ctxse")).toMatchObject({ sourceType: "Server", sourceBlock: null });
    expect(find("ctx.arg", "direct")).toMatchObject({ pos: { x: 22.5, y: -49.5, z: 0.5 }, origin: { sourceType: "Block" } });
    // BEでは整数座標の x・z が中心に寄る（JEでは 7.0 8.0 9.0）
    expect(find("ctx.arg", "positioned")).toMatchObject({ pos: { x: 7.5, y: 8, z: 9.5 }, forward: { x: 7.5, y: 8, z: 10.5 } });
    expect(find("ctx.arg", "rotated")?.forward).toEqual({ x: 6.5, y: 8, z: 9.5 });
    expect(find("ctx.arg", "as_at")).toMatchObject({
      pos: { x: 30.5, y: -60, z: 40.5 },
      executor: [{ type: "minecraft:armor_stand", tags: ["ctx_stand"] }],
      origin: { sourceType: "Entity", sourceEntity: "minecraft:armor_stand" },
    });
    // 未解決：execute in the_nether を挟むとハンドラが呼ばれない（原因未調査。#8）
    expect(find("ctx.custom", "nether")).toBeUndefined();
    expect(find("ctx.arg", "nether")).toBeUndefined();
    expect(results.contentLog).toEqual([]);
  });
});
