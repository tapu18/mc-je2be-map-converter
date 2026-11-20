// #31: 同じ座標とネイティブのスコア加算で、両版の常時実行リピートを比較する。
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { BedrockServer, JavaServer, jsonLines, paths, waitBedrockTicks, waitForLog, writeStructure } from "@je2be/bridge";
import { buildMcstructure, commandBlock } from "@je2be/core";

const here = dirname(fileURLToPath(import.meta.url));
const Y = -50;
const WARMUP = 10;
const TICKS = 40;
type Pos = [number, number, number];
type Neighbor = "chests" | "hoppers";
interface Layout {
  name: string;
  chunks: number[];
  reverse?: boolean;
  neighbor?: Neighbor;
  flatOffset?: 0 | 8;
}

const layouts: Layout[] = [
  { name: "dense99", chunks: [99] },
  { name: "dense100", chunks: [100] },
  { name: "dense101", chunks: [101] },
  { name: "dense200", chunks: [200] },
  { name: "dense200Flat", chunks: [200], flatOffset: 0 },
  { name: "skewed200", chunks: [150, 50] },
  { name: "twoChunks200", chunks: [100, 100], flatOffset: 8 },
  { name: "fourChunks200", chunks: [50, 50, 50, 50] },
  { name: "dense200Reversed", chunks: [200], reverse: true },
  { name: "dense100Chests", chunks: [100], neighbor: "chests" },
  { name: "dense100Hoppers", chunks: [100], neighbor: "hoppers" },
];

const dense = layouts.find(({ name }) => name === "dense200")!;

function positions({ chunks, flatOffset }: Layout): Pos[] {
  if (flatOffset !== undefined) {
    // 16×12 と中央8個の列。x を8ずらすと、形とIDを保ったまま100個ずつに分かれる。
    return Array.from({ length: 16 }, (_, x) =>
      Array.from({ length: x >= 4 && x < 12 ? 13 : 12 }, (_, z): Pos => [x + flatOffset, Y, z])).flat();
  }
  return chunks.flatMap((count, chunk) => Array.from({ length: count }, (_, i): Pos =>
    [16 * chunk + i % 10, Y + Math.floor(i / 100), Math.floor(i / 10) % 10]));
}

function batches(layout: Layout): { id: number; pos: Pos }[][] {
  const blocks = positions(layout).map((pos, id) => ({ id, pos }));
  // 上下の層を別々に置き、反転しても座標ごとのコマンドは変えない（#18）。
  const groups = layout.flatOffset === undefined && layout.chunks.length === 1 && blocks.length === 200
    ? [blocks.slice(0, 100), blocks.slice(100)]
    : [blocks];
  return layout.reverse ? groups.reverse() : groups;
}

const cmd = (id: number): string => `scoreboard players add b${id} density 1`;
const versions = JSON.parse(readFileSync(join(here, "../../tools/servers.json"), "utf8")) as {
  bedrock: { version: string }; java: { version: string };
};
const results = {
  versions: { bedrock: versions.bedrock.version, java: versions.java.version },
  warmupTicks: WARMUP,
  ticks: TICKS,
  layouts,
  bedrockSettings: {} as Record<string, unknown>,
  bedrock: {} as Record<string, unknown>,
  java: {} as Record<string, unknown>,
};

afterAll(() => {
  writeFileSync(join(paths.servers, "results.repeat-density.json"), JSON.stringify(results, null, 2) + "\n");
});

interface Series {
  start: number;
  end: number;
  updatesByChunk: number[][];
  largestDelta: number;
  smallestDelta: number;
}

it("measures Bedrock repeat updates by chunk, placement, neighbors and configuration", async () => {
  const pack = mkdtempSync(join(tmpdir(), "je2be-density-be-"));
  const propertyFile = join(paths.bedrockServer, "server.properties");
  let bds: BedrockServer | undefined;
  let properties: string | undefined;
  try {
    cpSync(join(here, "pack"), pack, { recursive: true });
    for (const layout of layouts) {
      for (const [index, blocks] of batches(layout).entries()) {
        writeStructure(pack, `${layout.name.toLowerCase()}_${index}`, buildMcstructure({
          size: [64, 2, 13],
          fillAir: false,
          blocks: blocks.map(({ id, pos: [x, y, z] }) => commandBlock({
            pos: [x, y - Y, z], kind: "repeat", command: cmd(id), facing: 3, alwaysActive: true,
          })),
        }));
      }
    }
    bds = await BedrockServer.start({ behaviorPacks: [pack] });
    properties = readFileSync(propertyFile, "utf8");
    const run = async (command: string): Promise<void> => {
      const response = await bds!.exec(command);
      expect(response.result?.successCount, `${command}: ${JSON.stringify(response)}`).toBeGreaterThan(0);
    };
    const measure = async (
      name: string, layout: Layout, rules: { commandBlocksEnabled?: boolean; [key: string]: unknown } = {},
    ): Promise<void> => {
      await waitBedrockTicks(bds!, WARMUP);
      const from = bds!.log.length;
      const count = positions(layout).length;
      const byChunk = layout.chunks.map((n) => rules.commandBlocksEnabled === false ? 0 : Math.min(n, 100));
      const expected = byChunk.reduce((sum, n) => sum + n, 0);
      await run("scriptevent je2be:density-sample " + JSON.stringify({
        chunks: layout.chunks, ticks: TICKS, ...(layout.neighbor === "hoppers" ? { hopperY: Y - 1 } : {}),
      }));
      await waitForLog(bds!.log, (line) => line.includes("DENSITY_DONE"), 30_000, from);
      const [series] = jsonLines<Series>(bds!.log, "DENSITY_SERIES", from);
      const perBlock = jsonLines<{ offset: number; deltas: number[] }>(bds!.log, "DENSITY_BLOCKS", from)
        .sort((a, b) => a.offset - b.offset).flatMap(({ deltas }) => deltas);
      const [gameRules] = jsonLines(bds!.log, "DENSITY_RULES", from);
      const [hoppers] = jsonLines<{ before: number[]; after: number[] }>(bds!.log, "DENSITY_HOPPERS", from);
      results.bedrock[name] = { layout: layout.name, ...series, perBlock, gameRules, hoppers };
      expect(series!.end - series!.start).toBe(TICKS);
      expect(series!.updatesByChunk, name).toEqual(byChunk.map((n) => Array(TICKS).fill(n)));
      expect(series!.smallestDelta).toBe(expected === count ? 1 : 0);
      expect(series!.largestDelta).toBe(expected ? 1 : 0);
      expect(perBlock).toHaveLength(count);
      expect(perBlock.reduce((sum, n) => sum + n, 0)).toBe(expected * TICKS);
      expect(gameRules).toMatchObject(rules);
      if (expected) expect(Math.min(...perBlock)).toBeGreaterThan(0);
      if (layout.neighbor === "hoppers") {
        expect(hoppers?.before).toHaveLength(100);
        expect(hoppers?.after).toHaveLength(100);
        expect(hoppers?.after.every((n, i) => n < hoppers.before[i]!)).toBe(true);
      }
    };

    await run("gamerule commandblockoutput false");
    await run("scoreboard objectives add density dummy");
    for (const [i, layout] of layouts.entries()) {
      expect(positions(layout).map(([x]) => Math.floor(x / 16))).toEqual(
        layout.chunks.flatMap((count, chunk) => Array(count).fill(chunk)),
      );
      if (i) await run(`fill 0 ${Y - 2} 0 63 ${Y + 1} 12 air`);
      if (layout.neighbor === "chests") await run(`fill 0 ${Y - 1} 0 9 ${Y - 1} 9 chest`);
      if (layout.neighbor === "hoppers") {
        await run(`fill 0 ${Y - 2} 0 9 ${Y - 2} 9 chest`);
        await run(`fill 0 ${Y - 1} 0 9 ${Y - 1} 9 hopper ["facing_direction"=0]`);
        const from = bds.log.length;
        await run(`scriptevent je2be:density-stock {"y":${Y - 1}}`);
        await waitForLog(bds.log, (line) => line.includes("DENSITY_STOCKED"), 30_000, from);
      }
      for (const index of batches(layout).keys()) {
        await run(`structure load je2be:${layout.name.toLowerCase()}_${index} 0 ${Y} 0`);
        await waitBedrockTicks(bds, 2);
      }
      await measure(layout.name, layout);
      if (layout.reverse) {
        bds = await bds.restart();
        await measure("bedrockRestart", layout);
      }
    }

    await run(`fill 0 ${Y - 2} 0 63 ${Y + 1} 12 air`);
    for (const index of batches(dense).keys()) await run(`structure load je2be:dense200_${index} 0 ${Y} 0`);
    const toggles = [
      { rule: "maxCommandChainLength", values: [1, 100000], initial: 65535 },
      { rule: "functionCommandLimit", values: [1, 10000], initial: 10000 },
      { rule: "randomTickSpeed", values: [0, 100], initial: 1 },
    ];
    for (const { rule, values, initial } of toggles) {
      for (const value of values) {
        await run(`gamerule ${rule} ${value}`);
        await measure(`${rule}_${value}`, dense, { [rule]: value });
      }
      await run(`gamerule ${rule} ${initial}`);
    }
    for (const enabled of [false, true]) {
      await run(`gamerule commandblocksenabled ${enabled}`);
      await measure(`commandBlocksEnabled_${enabled}`, dense, { commandBlocksEnabled: enabled });
    }
    expect(properties).toMatch(/^tick-distance=4\r?$/m);
    writeFileSync(propertyFile, properties.replace(/^tick-distance=4(?=\r?$)/m, "tick-distance=12"));
    bds = await bds.restart();
    await measure("tick-distance_12", dense);
    expect(properties).toMatch(/^persistent-ticking-area-max-chunks=100\r?$/m);
    // 16チャンクの既存エリアを維持し、設定が読まれたことを17チャンクの新規エリアで確認する。
    const addArea = "tickingarea add 64 0 0 335 0 0 density_probe";
    await run(addArea);
    await run("tickingarea remove density_probe");
    writeFileSync(propertyFile, properties.replace(/^persistent-ticking-area-max-chunks=100(?=\r?$)/m, "persistent-ticking-area-max-chunks=16"));
    bds = await bds.restart();
    const probe = await bds.exec(addArea);
    expect(probe.result?.successCount ?? 0).toBe(0);
    results.bedrockSettings = {
      tickDistance: { default: 4, tested: 12 },
      persistentTickingAreaMaxChunks: { default: 100, tested: 16, probeChunks: 17, acceptedBefore: true, after: probe },
    };
    await measure("persistent-ticking-area-max-chunks_16", dense);
  } finally {
    if (properties !== undefined) writeFileSync(propertyFile, properties);
    await bds?.stop();
    rmSync(pack, { recursive: true, force: true });
  }
});

it("measures Java repeat updates with the same layouts and restart", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "je2be-density-je-"));
  const pack = join(tmp, "density");
  const functions = join(pack, "data", "density", "function");
  let java: JavaServer | undefined;
  try {
    mkdirSync(functions, { recursive: true });
    writeFileSync(join(pack, "pack.mcmeta"), JSON.stringify({
      pack: { description: "je2be repeat density PoC", pack_format: 121, min_format: 121, max_format: 121 },
    }));
    for (const layout of layouts) {
      for (const [index, blocks] of batches(layout).entries()) {
        const commands = blocks.map(({ id, pos }) => `setblock ${pos.join(" ")} repeating_command_block[facing=south]{Command:"${cmd(id)}",auto:1b,TrackOutput:0b}`);
        writeFileSync(join(functions, `${layout.name.toLowerCase()}_${index}.mcfunction`), commands.join("\n") + "\n");
      }
    }
    const hoppers = positions({ name: "hoppers", chunks: [100] }).map(([x, y, z]) =>
      `setblock ${x} ${y - 1} ${z} hopper[facing=down]{Items:[{Slot:0b,id:"minecraft:stone",count:64}]}`);
    writeFileSync(join(functions, "hoppers.mcfunction"), hoppers.join("\n") + "\n");
    java = await JavaServer.start({ datapacks: [pack] });
    const time = async (): Promise<number> => {
      const response = await java!.exec("time query gametime");
      const match = /The game time is (\d+) tick/.exec(response);
      if (!match) throw new Error(`Could not read Java game time: ${response}`);
      return Number(match[1]);
    };
    const step = async (ticks: number): Promise<number> => {
      const target = await time() + ticks;
      expect(await java!.exec(`tick step ${ticks}`)).toMatch(/Stepping/);
      await expect.poll(time, { timeout: 15_000, interval: 50 }).toBe(target);
      return target;
    };
    const hopperItems = async (): Promise<number> => {
      const response = await java!.exec(`data get block 0 ${Y - 1} 0 Items[0].count`);
      const count = /block data: (\d+)/.exec(response);
      if (!count) throw new Error(`Could not read Java hopper: ${response}`);
      return Number(count[1]);
    };
    const measure = async (name: string, layout: Layout): Promise<void> => {
      await step(WARMUP);
      await java!.exec("scoreboard objectives remove density");
      expect(await java!.exec("scoreboard objectives add density dummy")).toMatch(/Created new objective/);
      const before = layout.neighbor === "hoppers" ? await hopperItems() : undefined;
      const end = await step(TICKS);
      const hoppers = before === undefined ? undefined : { before, after: await hopperItems() };
      if (hoppers) expect(hoppers.after).toBeLessThan(hoppers.before);
      const { scores } = await java!.dump({ scores: true });
      const objective = scores!.find(({ objective }) => objective === "density");
      const values = new Map(objective!.scores.map(({ participant, score }) => [participant, score]));
      const perBlock = positions(layout).map((_, i) => values.get(`b${i}`) ?? 0);
      const start = end - TICKS;
      const updatesPerTick = perBlock.reduce((sum, n) => sum + n, 0) / TICKS;
      results.java[name] = { layout: layout.name, start, end, perBlock, updatesPerTick, hoppers };
      expect(perBlock).toEqual(Array(positions(layout).length).fill(TICKS));
    };

    expect(await java.exec("gamerule minecraft:command_block_output false")).toMatch(/false/);
    expect(await java.exec("tick freeze")).toMatch(/frozen/);
    expect(await java.exec("scoreboard objectives add density dummy")).toMatch(/Created new objective/);
    for (const [i, layout] of layouts.entries()) {
      if (i) expect(await java.exec(`fill 0 ${Y - 2} 0 63 ${Y + 1} 12 air`)).toMatch(/Successfully filled/);
      if (layout.neighbor === "chests") expect(await java.exec(`fill 0 ${Y - 1} 0 9 ${Y - 1} 9 chest`)).toMatch(/100/);
      if (layout.neighbor === "hoppers") {
        expect(await java.exec(`fill 0 ${Y - 2} 0 9 ${Y - 2} 9 chest`)).toMatch(/100/);
        expect(await java.exec("function density:hoppers")).toMatch(/density:hoppers/);
      }
      for (const index of batches(layout).keys()) {
        const name = `density:${layout.name.toLowerCase()}_${index}`;
        expect(await java.exec(`function ${name}`)).toContain(name);
        await step(2);
      }
      await measure(layout.name, layout);
      if (layout.reverse) {
        java = await java.restart();
        expect(await java.exec("tick freeze")).toMatch(/frozen/);
        await measure("javaRestart", layout);
      }
    }
  } finally {
    await java?.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
});
