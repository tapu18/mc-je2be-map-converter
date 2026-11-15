// #10: 整数座標の中心寄せと、BE と Java の座標の扱いの差。
// 座標の書き方 × コマンドの組み合わせで防具立てを出し、位置を両エディションで比べる。
// 結果は poc/coordinates/results.json に書き出す（根拠としてコミットする）。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BedrockServer, JavaServer } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
const Y = -50;
const Z = 9;

const forms: Record<string, (x: number) => string> = {
  int: (x) => `${x} ${Y} ${Z}`,
  dot0: (x) => `${x}.0 ${Y} ${Z}.0`,
  half: (x) => `${x}.5 ${Y} ${Z}.5`,
  quarter: (x) => `${x}.25 ${Y} ${Z}.25`,
};
const commands: Record<string, (pos: string, entity: string) => string> = {
  summon: (pos, e) => `summon ${e} ${pos}`,
  positioned: (pos, e) => `execute positioned ${pos} run summon ${e} ~ ~ ~`,
  positionedOffset: (pos, e) => `execute positioned ${pos} run summon ${e} ~1 ~ ~`,
};

interface Case {
  name: string;
  x: number;
  command: (entity: string) => string;
}

const cases: Case[] = Object.entries(forms).flatMap(([fname, form], i) =>
  Object.entries(commands).map(([cname, cmd], j) => {
    const x = 2 + (i * 3 + j) * 5;
    return { name: `${cname}/${fname}`, x, command: (e: string) => cmd(form(x), e) };
  }),
);

// セレクタの x=,y=,z= の基準：角の近く（+0.05）と中心の近く（+0.55）に1体ずつ置き、半径0.3で一致するかを見る
const SEL_X = 10;
const SEL_Z = 30;
const selectorCases = [
  { name: "int", be: `x=${SEL_X},y=${Y},z=${SEL_Z},r=0.3`, java: `x=${SEL_X},y=${Y},z=${SEL_Z},distance=..0.3` },
  { name: "dot0", be: `x=${SEL_X}.0,y=${Y},z=${SEL_Z}.0,r=0.3`, java: `x=${SEL_X}.0,y=${Y},z=${SEL_Z}.0,distance=..0.3` },
];

type Pos = [number, number];
// tp：別の列（z=20）に出した防具立てを、各書き方の座標へ移す
const TP_Z = 20;
const tpCases = Object.entries(forms).map(([fname, form], i) => ({ name: `tp/${fname}`, x: 2 + i * 5, form }));

// setblock：小数を直接書く場合と、positioned 経由の ~ の場合（z=35 の列）
const SB_Z = 35;
const setblockCases = [
  { name: "setblock/decimal", x: 3, command: (x: number) => `setblock ${x}.9 ${Y} ${SB_Z}.9 STONE` },
  { name: "setblock/positioned~", x: 8, command: (x: number) => `execute positioned ${x}.9 ${Y} ${SB_Z}.9 run setblock ~ ~ ~ STONE` },
  { name: "setblock/positioned~0.5", x: 13, command: (x: number) => `execute positioned ${x}.9 ${Y} ${SB_Z}.9 run setblock ~0.5 ~ ~0.5 STONE` },
];

const results: Record<string, unknown> = { cases: {} as Record<string, { be?: Pos; java?: Pos }>, selectors: {}, setblock: {} };
const sbResults = results.setblock as Record<string, { be?: unknown; java?: unknown }>;
const caseResults = results.cases as Record<string, { be?: Pos; java?: Pos }>;
const selResults = results.selectors as Record<string, { be?: unknown; java?: unknown }>;

afterAll(() => {
  writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");
});

describe("coordinates (bedrock)", () => {
  let bds: BedrockServer;
  beforeAll(async () => { bds = await BedrockServer.start(); });
  afterAll(async () => { await bds?.stop(); });

  it("records entity positions", async () => {
    // 落下しても x・z は変わらないが、念のため床を敷く
    await bds.exec(`fill 0 ${Y - 1} 0 63 ${Y - 1} 40 stone`);
    for (const c of cases) {
      const res = await bds.exec(c.command("armor_stand"));
      expect(res.result?.successCount, c.name).toBe(1);
    }
    for (const t of tpCases) {
      await bds.exec(`summon armor_stand ${t.x}.3 ${Y} ${TP_Z}.3`);
      const res = await bds.exec(`tp @e[type=armor_stand,x=${t.x},y=${Y - 1},z=${TP_Z},dx=1,dy=2,dz=1] ${t.form(t.x).replace(` ${Z}`, ` ${TP_Z}`)}`);
      expect(res.result?.successCount, t.name).toBe(1);
    }
    for (const b of setblockCases) {
      const res = await bds.exec(b.command(b.x).replace("STONE", "stone"));
      const blocks = await bds.request<{ pos: number[]; type: string }[]>("blocks", { from: [b.x - 1, Y, SB_Z - 1], to: [b.x + 2, Y, SB_Z + 2] });
      sbResults[b.name] = { ...sbResults[b.name], be: { ok: res.ok && (res.result?.successCount ?? 0) > 0, error: res.error, at: blocks.result?.filter((x) => x.type === "minecraft:stone").map((x) => [x.pos[0], x.pos[2]]) } };
    }
    await new Promise((r) => setTimeout(r, 1000));

    const ents = await bds.request<{ type: string; pos: number[] }[]>("entities", { query: { type: "minecraft:armor_stand" } });
    for (const c of cases) {
      const e = ents.result?.find((en) => en.pos[0]! >= c.x - 1 && en.pos[0]! < c.x + 4 && en.pos[2]! < 15);
      caseResults[c.name] = { ...caseResults[c.name], be: [e!.pos[0]!, e!.pos[2]!] };
    }
    for (const t of tpCases) {
      const e = ents.result?.find((en) => en.pos[0]! >= t.x - 1 && en.pos[0]! < t.x + 4 && en.pos[2]! >= 15 && en.pos[2]! < 25);
      caseResults[t.name] = { ...caseResults[t.name], be: [e!.pos[0]!, e!.pos[2]!] };
    }
    // 角の近く（+0.05）と中心の近く（+0.55）に1体ずつ置き、それぞれ一致するかを見る
    for (const [where, off] of [["corner", "05"], ["center", "55"]] as const) {
      await bds.exec(`summon minecart ${SEL_X}.${off} ${Y} ${SEL_Z}.${off}`);
      await new Promise((r) => setTimeout(r, 300));
      for (const s of selectorCases) {
        const res = await bds.exec(`testfor @e[type=minecart,${s.be}]`);
        selResults[`${s.name}/${where}`] = { ...selResults[`${s.name}/${where}`], be: (res.result?.successCount ?? 0) > 0 };
      }
      await bds.exec("kill @e[type=minecart]");
    }
  });
});

describe("coordinates (java)", () => {
  let java: JavaServer;
  beforeAll(async () => { java = await JavaServer.start(); });
  afterAll(async () => { await java?.stop(); });

  it("records entity positions", async () => {
    await java.exec(`fill 0 ${Y - 1} 0 63 ${Y - 1} 40 minecraft:stone`);
    for (const c of cases) expect(await java.exec(c.command("minecraft:armor_stand")), c.name).toMatch(/Summoned/);
    for (const t of tpCases) {
      await java.exec(`summon minecraft:armor_stand ${t.x}.3 ${Y} ${TP_Z}.3`);
      const text = await java.exec(`tp @e[type=minecraft:armor_stand,x=${t.x},y=${Y - 1},z=${TP_Z},dx=1,dy=2,dz=1] ${t.form(t.x).replace(` ${Z}`, ` ${TP_Z}`)}`);
      expect(text, t.name).toMatch(/Teleported/);
    }
    for (const b of setblockCases) {
      const text = await java.exec(b.command(b.x).replace("STONE", "minecraft:stone"));
      const at: number[][] = [];
      for (let x = b.x - 1; x <= b.x + 2; x++)
        for (let z = SB_Z - 1; z <= SB_Z + 2; z++)
          if (/Test passed/.test(await java.exec(`execute if block ${x} ${Y} ${z} minecraft:stone`))) at.push([x, z]);
      sbResults[b.name] = { ...sbResults[b.name], java: { ok: /Changed the block/.test(text), message: text, at } };
    }
    await new Promise((r) => setTimeout(r, 1000));

    for (const c of cases) {
      const text = await java.exec(`data get entity @e[type=minecraft:armor_stand,x=${c.x - 1},y=${Y - 5},z=0,dx=4,dy=10,dz=19,limit=1] Pos`);
      const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(text);
      expect(m, `${c.name}: ${text}`).not.toBeNull();
      caseResults[c.name] = { ...caseResults[c.name], java: [Number(m![1]), Number(m![3])] };
    }
    for (const t of tpCases) {
      const text = await java.exec(`data get entity @e[type=minecraft:armor_stand,x=${t.x - 1},y=${Y - 5},z=15,dx=4,dy=10,dz=9,limit=1] Pos`);
      const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(text);
      expect(m, `${t.name}: ${text}`).not.toBeNull();
      caseResults[t.name] = { ...caseResults[t.name], java: [Number(m![1]), Number(m![3])] };
    }
    for (const [where, off] of [["corner", "05"], ["center", "55"]] as const) {
      await java.exec(`summon minecraft:minecart ${SEL_X}.${off} ${Y} ${SEL_Z}.${off}`);
      await new Promise((r) => setTimeout(r, 300));
      for (const s of selectorCases) {
        const text = await java.exec(`execute if entity @e[type=minecraft:minecart,${s.java}]`);
        selResults[`${s.name}/${where}`] = { ...selResults[`${s.name}/${where}`], java: /Test passed/.test(text) };
      }
      await java.exec("kill @e[type=minecraft:minecart]");
    }
  });
});

// ---- 実測で確かめた事実（両エディションの記録が揃った後に比べる） ----
describe("coordinates (comparison)", () => {
  it("matches between editions except decimal block positions", () => {
    // 位置：summon / positioned / ~ / tp のどれでも、BE と Java は一致する
    for (const [name, v] of Object.entries(caseResults)) expect(v.be, name).toEqual(v.java);
    // 整数の x・z は中心（+0.5）に寄り、.0 を付けると寄らない（両エディション）
    expect(caseResults["positioned/int"]).toEqual({ be: [7.5, 9.5], java: [7.5, 9.5] });
    expect(caseResults["positioned/dot0"]).toEqual({ be: [22, 9], java: [22, 9] });
    expect(caseResults["positionedOffset/int"]).toEqual({ be: [13.5, 9.5], java: [13.5, 9.5] });
    // セレクタの x=,y=,z= は中心に寄らない（両エディション）
    expect(selResults).toEqual({
      "int/corner": { be: true, java: true },
      "dot0/corner": { be: true, java: true },
      "int/center": { be: false, java: false },
      "dot0/center": { be: false, java: false },
    });
    // ブロック座標に小数を直接書くと、Java は構文エラー、BE は切り捨てて実行する
    expect(sbResults["setblock/decimal"]).toMatchObject({ be: { ok: true, at: [[3, 35]] }, java: { ok: false, at: [] } });
    // ~ を使うと両エディションとも切り捨て
    expect(sbResults["setblock/positioned~"]).toMatchObject({ be: { at: [[8, 35]] }, java: { at: [[8, 35]] } });
    expect(sbResults["setblock/positioned~0.5"]).toMatchObject({ be: { at: [[14, 36]] }, java: { at: [[14, 36]] } });
  });
});
