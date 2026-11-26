import { rmSync } from "node:fs";
import { expect, it } from "vitest";
import { BedrockServer } from "./bedrock.ts";
import { buildConvertedWorld } from "./scenario/run.ts";
import type { ScenarioCommandBlock } from "./scenario/types.ts";

it("uses Chunker's primary states for placement and exact block conditions", async () => {
  const mushroom = "minecraft:brown_mushroom_block";
  const mushroomA = `${mushroom}[down=false,east=false,north=true,south=true,up=false,west=true]`;
  const mushroomB = `${mushroom}[down=false,east=false,north=true,south=true,up=true,west=false]`;
  const beets = "minecraft:beetroots[age=1]";
  const slab = "minecraft:oak_slab[type=top]";
  const placement = [
    `setblock 3 -59 2 ${beets}`,
    `fill 4 -59 2 5 -59 2 ${beets}`,
    `setblock 6 -59 6 ${mushroomA}`,
    `fill 8 -59 6 8 -59 6 ${mushroomB}`,
  ];
  const condition = (kind: "if" | "unless", pos: string, block: string) =>
    `execute ${kind} block ${pos} ${block} run scoreboard players add probe checks 1`;
  const checks = [
    ...[2, 3, 4, 5, 6].flatMap(x => [
      [condition("if", `${x} -59 2`, beets), Number(x !== 6)],
      [condition("unless", `${x} -59 2`, beets), Number(x === 6)],
      [condition("if", `${x} -59 2`, "minecraft:beetroots"), 1],
    ] as const),
    ...[2, 4, 6, 8].map(x => [condition("if", `${x} -59 6`, "brown_mushroom_block"), 1] as const),
    ...[2, 8].flatMap(x => [
      [condition("if", `${x} -59 10`, slab), 1],
      [condition("unless", `${x} -59 10`, slab), 0],
    ] as const),
  ];
  const unsupported = [
    [condition("if", "2 -59 6", mushroomA), "同じ BE 主層の状態"],
    [condition("unless", "4 -59 6", `${mushroom}[up=true]`), "同じ BE 主層の状態"],
    [condition("if", "2 -59 10", "minecraft:oak_slab[type=top,waterlogged=true]"), "水没の有無"],
    [condition("unless", "8 -59 10", "minecraft:oak_slab[type=top,waterlogged=false]"), "水没の有無"],
  ] as const;
  const wetPlacement = "setblock 12 -59 10 minecraft:oak_slab[type=top,waterlogged=true]";
  const commandBlocks = [...placement, ...checks.map(([cmd]) => cmd), ...unsupported.map(([cmd]) => cmd), wetPlacement]
    .map((command, i): ScenarioCommandBlock => ({
      command, pos: [i % 16, -57, 12 + Math.floor(i / 16)], kind: "impulse", facing: "up", alwaysActive: false,
    }));
  const { work, world, report } = await buildConvertedWorld({
    description: "Chunker block states and commands",
    setup: [
      "gamerule minecraft:random_tick_speed 0",
      "fill 2 -60 2 6 -60 2 minecraft:farmland[moisture=7]",
      `setblock 2 -59 2 ${beets}`,
      "setblock 6 -59 2 minecraft:beetroots[age=2]",
      `setblock 2 -59 6 ${mushroomA} strict`,
      `setblock 4 -59 6 ${mushroomB} strict`,
      "setblock 2 -59 10 minecraft:oak_slab[type=top,waterlogged=true] strict",
      "setblock 8 -59 10 minecraft:oak_slab[type=top,waterlogged=false] strict",
    ],
    actions: [{ commandBlocks }],
    observe: {},
  }, []);

  try {
    const rewritten = new Map(report.commands?.commandBlocks.map(entry => [entry.java, entry]));
    const bedrock = (java: string): string => {
      const entry = rewritten.get(java);
      expect(entry, java).toMatchObject({ status: "rewritten", bedrock: expect.any(String) });
      return entry!.bedrock!;
    };
    for (const [java, reason] of unsupported) {
      expect(rewritten.get(java), java).toMatchObject({
        status: "unsupported",
        issues: [{ severity: "unsupported", message: expect.stringContaining(reason) }],
      });
    }
    expect(rewritten.get(wetPlacement)).toMatchObject({
      status: "rewritten",
      issues: [{ severity: "warning", message: expect.stringContaining("水が入らない") }],
    });

    const bds = await BedrockServer.start({ world, tickingArea: [0, 0, 15, 15] });
    try {
      const exec = async (command: string, successCount: number) => {
        expect(await bds.exec(command), command).toMatchObject({ ok: true, result: { successCount } });
      };
      await exec("gamerule randomtickspeed 0", 1);
      await exec("scoreboard objectives add checks dummy", 1);
      await exec("scoreboard players set probe checks 0", 1);
      for (const java of placement) await exec(bedrock(java), 1);
      await exec(bedrock(wetPlacement), 1);
      for (const [java, expected] of checks) await exec(bedrock(java), expected);
      await exec(`execute if score probe checks matches ${checks.reduce((sum, [, count]) => sum + count, 0)} run say count`, 1);

      // Distinguish the original mismatch and the two collapsed Java states in live BDS.
      await exec('execute if block 2 -59 2 minecraft:beetroot ["growth"=3] run say old', 0);
      for (const x of [2, 4, 6, 8]) {
        await exec(`execute if block ${x} -59 6 ${mushroom} ["huge_mushroom_bits"=14] run say same`, 1);
      }
      for (const [x, waterlogged] of [[2, true], [8, false], [12, false]] as const) {
        expect(await bds.request("blockWaterlogged", { pos: [x, -59, 10] })).toMatchObject({ ok: true, result: waterlogged });
        await exec(`execute if block ${x} -59 10 minecraft:water run say layer`, 0);
      }
    } finally {
      await bds.stop();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
