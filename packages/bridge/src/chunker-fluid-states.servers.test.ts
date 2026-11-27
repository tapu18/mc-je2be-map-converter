import { rmSync } from "node:fs";
import { expect, it } from "vitest";
import { BedrockServer } from "./bedrock.ts";
import { waitBedrockTicks } from "./poc-kit.ts";
import { buildConvertedWorld, runJava } from "./scenario/run.ts";
import type { ScenarioCommandBlock } from "./scenario/types.ts";

// #340: Chunker が保存した水・溶岩と、書き換えた配置・条件を BDS で照合する。
// 各流体のセルは周りをガラスで囲み、Java では tick を止めたまま置く。
type Fluid = "water" | "lava";
type Cell = { fluid: Fluid; pos: [number, number, number]; level: number };
const cell = (fluid: Fluid, x: number, y: number, z: number, level: number): Cell => ({ fluid, pos: [x, y, z], level });
const at = (c: Cell) => c.pos.join(" ");
const java = (c: Cell, level = c.level) => `minecraft:${c.fluid}[level=${level}]`;

/** 水源から横に流れ、終わりまで安定した流れと、水源の下に流れ落ちる列 */
const stable: Cell[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(level => cell("water", 2 + level, -59, 2, level)),
  cell("water", 12, -55, 2, 0), ...[-56, -57, -58, -59].map(y => cell("water", 12, y, 2, 8)),
  ...[0, 2, 4, 6].map((level, i) => cell("lava", 2 + i, -59, 6, level)),
  cell("lava", 12, -55, 6, 0), ...[-56, -57, -58, -59].map(y => cell("lava", 12, y, 6, 8)),
];
/** 水源につながらない流水（Java では保留中の更新が付いたまま保存される） */
const isolated: Cell[] = [cell("water", 2, -59, 10, 3), cell("water", 4, -59, 10, 10), cell("lava", 6, -59, 10, 4), cell("lava", 8, -59, 10, 10)];
const terrain = [...stable, ...isolated];
const setup = ["fill 0 -60 0 15 -53 13 minecraft:glass", ...terrain.map(c => `setblock ${at(c)} ${java(c)}`), "setblock 2 -59 12 minecraft:water[level=0]"];

/** コマンドで置く流体。水源の隣の流水は残り、孤立した流水は消える */
const placed = [cell("water", 3, -59, 12, 1), cell("water", 6, -59, 12, 3), cell("lava", 9, -59, 12, 4)];
const placement = [
  `setblock ${at(placed[0]!)} ${java(placed[0]!)}`,
  `setblock ${at(placed[1]!)} ${java(placed[1]!)}`,
  `fill ${at(placed[2]!)} ${at(placed[2]!)} ${java(placed[2]!)}`,
];
const settledPlacement = { "3,-59,12": "minecraft:water[level=1]", "6,-59,12": "minecraft:air", "9,-59,12": "minecraft:air" };
/** 横の壁を開けると、BDS が地形の流水から新しく流す */
const spread = cell("water", 4, -59, 3, 3);

const condition = (kind: "if" | "unless", pos: string, block: string) =>
  `execute ${kind} block ${pos} ${block} run scoreboard players add probe checks 1`;
/** 地形の各セルで、ID だけ、同じ水位、違う水位の条件と、その unless */
const terrainChecks = terrain.flatMap(c => {
  const other = c.level === 8 ? 0 : 8;
  return [
    [condition("if", at(c), `minecraft:${c.fluid}`), 1],
    [condition("if", at(c), java(c)), 1],
    [condition("unless", at(c), java(c)), 0],
    [condition("if", at(c), java(c, other)), 0],
    [condition("unless", at(c), java(c, other)), 1],
  ] as const;
});
const placedChecks = [
  [condition("if", at(placed[0]!), java(placed[0]!)), 1],
  [condition("unless", at(placed[0]!), java(placed[0]!)), 0],
  [condition("if", at(spread), java(spread)), 1],
  [condition("if", at(spread), "minecraft:water[level=1]"), 0],
] as const;

it("keeps Java's placement result for isolated and connected flowing fluids", async () => {
  const { state } = await runJava({
    description: "Java fluid placement",
    setup,
    actions: [...placement.map(run => ({ run })), { ticks: 200 }],
    observe: { blocks: placed.map(c => ({ from: c.pos })) },
  });
  expect(state.blocks).toEqual(settledPlacement);
});

it("matches Chunker's fluids and rewritten fluid commands in BDS", async () => {
  const commandBlocks = [...placement, ...terrainChecks.map(([cmd]) => cmd), ...placedChecks.map(([cmd]) => cmd)]
    .map((command, i): ScenarioCommandBlock => ({
      command, pos: [i % 16, -50, Math.floor(i / 16)], kind: "impulse", facing: "up", alwaysActive: false,
    }));
  const { work, world, report } = await buildConvertedWorld({
    description: "Chunker fluids and commands", setup, actions: [{ commandBlocks }], observe: {},
  }, []);
  try {
    const rewritten = new Map(report.commands?.commandBlocks.map(entry => [entry.java, entry]));
    // 書き換えレポートは変わらないコマンドを載せない
    const bedrock = (command: string): string => {
      const entry = rewritten.get(command);
      if (!entry) return command;
      expect(entry, command).toMatchObject({ status: "rewritten", bedrock: expect.any(String) });
      return entry.bedrock!;
    };
    // 配置は流水の ID（置いた後に更新される）、条件は静止の ID で書き換わる
    expect(bedrock(placement[1]!)).toContain('minecraft:flowing_water ["liquid_depth"=3]');
    expect(bedrock(terrainChecks[6]![0])).toContain('minecraft:water ["liquid_depth"=1]');

    const bds = await BedrockServer.start({ world, tickingArea: [0, 0, 15, 15] });
    try {
      const exec = async (command: string, successCount: number) => {
        expect(await bds.exec(command), command).toMatchObject({ ok: true, result: { successCount } });
      };
      const read = async (cells: Cell[]) => Promise.all(cells.map(async c => {
        const res = await bds.request<{ type: string; states: Record<string, unknown> }[]>("blocks", { from: c.pos });
        const [b] = res.result!;
        return b!.type === "minecraft:air" ? "air" : `${b!.type}[${String(b!.states.liquid_depth)}]`;
      }));
      const expected = (cells: Cell[]) => cells.map(c => `minecraft:${c.fluid}[${c.level}]`);
      const checks = async (list: readonly (readonly [string, number])[]) => {
        for (const [command, count] of list) await exec(bedrock(command), count);
      };
      await exec("scoreboard objectives add checks dummy", 1);

      // ロード直後と、何も起きないまま 100 tick 後。Chunker の地形は流水も静止の ID で、更新が予約されていない
      expect(await read(terrain)).toEqual(expected(terrain));
      await checks(terrainChecks);
      await waitBedrockTicks(bds, 100);
      expect(await read(terrain)).toEqual(expected(terrain));
      for (const c of terrain.slice(0, 3)) await exec(`execute if block ${at(c)} minecraft:flowing_${c.fluid} run say flowing`, 0);

      // 書き換えた setblock / fill。Java と同じく、水源の隣の流水は残り、孤立した流水は消える
      // 対照: 静止の ID で置いた流水は更新が予約されず、孤立していても残る
      const still = cell("water", 12, -59, 10, 3);
      for (const command of placement) await exec(bedrock(command), 1);
      await exec(`setblock ${at(still)} minecraft:water ["liquid_depth"=3]`, 1);
      await waitBedrockTicks(bds, 200);
      expect(await read(placed)).toEqual(["minecraft:water[1]", "air", "air"]);
      expect(await read([still])).toEqual(expected([still]));

      // 隣のブロックの更新。安定した流れは ID も水位も変わらず、孤立した流水は消える
      for (const command of [...[2, 6, 10].map(z => `fill 1 -58 ${z} 13 -58 ${z} minecraft:stone replace minecraft:glass`), `setblock ${at(spread)} minecraft:air`]) {
        expect(await bds.exec(command), command).toMatchObject({ ok: true });
      }
      await waitBedrockTicks(bds, 200);
      expect(await read(stable)).toEqual(expected(stable));
      expect(await read([...isolated, still])).toEqual([...isolated, still].map(() => "air"));
      expect(await read([spread])).toEqual(expected([spread]));
      await checks(placedChecks);

      const total = [...terrainChecks, ...placedChecks].reduce((sum, [, count]) => sum + count, 0);
      await exec(`execute if score probe checks matches ${total} run say count`, 1);
    } finally {
      await bds.stop();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
