import { describe, expect, it } from "vitest";
import { nbt, writeNbt, type NbtCompound, type NbtTag } from "../nbt/nbt.ts";
import { blockAt, nbtToPlain, paletteEntry, readCommandStorage, readScoreboard, RegionFile, rewriteRegion } from "./world.ts";

/** パレットと、各位置のパレット番号からセクションを作る（Java の詰め方：long をまたがない） */
function section(y: number, palette: NbtTag[], indexAt: (i: number) => number): NbtCompound {
  const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
  const perLong = Math.floor(64 / bits);
  const data = new BigInt64Array(Math.ceil(4096 / perLong));
  for (let i = 0; i < 4096; i++) {
    const w = Math.floor(i / perLong);
    data[w] = BigInt.asIntN(64, BigInt.asUintN(64, data[w]!) | (BigInt(indexAt(i)) << BigInt((i % perLong) * bits)));
  }
  return nbt.compound({
    Y: nbt.byte(y),
    block_states: nbt.compound({ palette: nbt.list("compound", palette), data: { type: "longArray", value: data } }),
  });
}

const wrapped = (s: string): NbtTag => nbt.compound({ "": nbt.string(s) });
const withProps = (id: string, props: Record<string, string>): NbtTag =>
  nbt.compound({ id: nbt.string(id), properties: nbt.compound(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, nbt.string(v)]))) });

describe("java world", () => {
  it("normalizes all palette entry forms", () => {
    expect(paletteEntry(wrapped("minecraft:stone"))).toEqual({ name: "minecraft:stone", properties: {} });
    expect(paletteEntry(withProps("minecraft:oak_stairs", { half: "top" }))).toEqual({ name: "minecraft:oak_stairs", properties: { half: "top" } });
    expect(paletteEntry(nbt.compound({ Name: nbt.string("minecraft:dirt"), Properties: nbt.compound({ snowy: nbt.string("false") }) }))).toEqual({
      name: "minecraft:dirt",
      properties: { snowy: "false" },
    });
    expect(paletteEntry(nbt.string("minecraft:lever[face=wall,powered=true]"))).toEqual({
      name: "minecraft:lever",
      properties: { face: "wall", powered: "true" },
    });
  });

  it("fills omitted properties with defaults", () => {
    const defaults = (name: string): Record<string, string> | undefined =>
      name === "minecraft:command_block" ? { conditional: "false", facing: "north" } : undefined;
    expect(paletteEntry(wrapped("minecraft:command_block"), defaults)).toEqual({ name: "minecraft:command_block", properties: { conditional: "false", facing: "north" } });
    expect(paletteEntry(withProps("minecraft:command_block", { facing: "up" }), defaults).properties).toEqual({ conditional: "false", facing: "up" });
    expect(paletteEntry(wrapped("minecraft:stone"), defaults)).toEqual({ name: "minecraft:stone", properties: {} });
  });

  it("reads blocks from packed section data (5 bits per entry)", () => {
    const palette = Array.from({ length: 17 }, (_, i) => wrapped(`minecraft:b${i}`));
    // index = (y*16 + z)*16 + x
    const pick = (i: number): number => (i * 7) % 17;
    const chunk = nbt.compound({ sections: nbt.list("compound", [section(-4, palette, pick)]) });
    for (const [x, y, z] of [[0, -64, 0], [15, -49, 15], [3, -50, 2], [7, -60, 11]] as const) {
      const i = ((y & 15) * 16 + (z & 15)) * 16 + (x & 15);
      expect(blockAt(chunk, x, y, z)?.name).toBe(`minecraft:b${pick(i)}`);
    }
    expect(blockAt(chunk, 0, 0, 0)).toBeUndefined();
  });

  it("reads a single-entry palette without data", () => {
    const chunk = nbt.compound({
      sections: nbt.list("compound", [nbt.compound({ Y: nbt.byte(0), block_states: nbt.compound({ palette: nbt.list("compound", [wrapped("minecraft:air")]) }) })]),
    });
    expect(blockAt(chunk, 5, 5, 5)?.name).toBe("minecraft:air");
  });

  it("reads uncompressed chunks from a region file", () => {
    const body = writeNbt({ name: "", tag: nbt.compound({ xPos: nbt.int(1), zPos: nbt.int(2) }) }, "java");
    const region = new Uint8Array(8192 + 4096);
    const view = new DataView(region.buffer);
    const idx = 1 + 2 * 32;
    view.setUint32(idx * 4, (2 << 8) | 1); // 2セクタ目から1セクタ
    view.setUint32(8192, body.length + 1);
    region[8192 + 4] = 3;
    region.set(body, 8192 + 5);
    const file = new RegionFile(region, () => { throw new Error("not compressed"); });
    expect(nbtToPlain(file.chunk(1, 2)!)).toEqual({ xPos: 1, zPos: 2 });
    expect(file.chunk(0, 0)).toBeUndefined();
  });

  it("rewrites only the edited chunks of a region and keeps the others byte for byte", () => {
    const region = new Uint8Array(8192 + 2 * 4096);
    const view = new DataView(region.buffer);
    const put = (idx: number, sector: number, tag: ReturnType<typeof nbt.compound>): void => {
      const body = writeNbt({ name: "", tag }, "java");
      view.setUint32(idx * 4, (sector << 8) | 1);
      view.setUint32(4096 + idx * 4, 1234); // 更新時刻
      view.setUint32(sector * 4096, body.length + 1);
      region[sector * 4096 + 4] = 3;
      region.set(body, sector * 4096 + 5);
    };
    put(0, 2, nbt.compound({ v: nbt.int(1) }));
    put(33, 3, nbt.compound({ v: nbt.int(2) }));
    const identity = (_k: "gzip" | "zlib", d: Uint8Array): Uint8Array => d;
    expect(rewriteRegion(region, identity, (d) => d, () => undefined)).toBeUndefined();
    const out = rewriteRegion(region, identity, (d) => d, (c) => (nbtToPlain(c) as { v: number }).v === 2 ? nbt.compound({ v: nbt.int(3) }) : undefined)!;
    const file = new RegionFile(out, identity);
    expect(nbtToPlain(file.chunk(0, 0)!)).toEqual({ v: 1 });
    expect(nbtToPlain(file.chunk(1, 1)!)).toEqual({ v: 3 });
    expect(new DataView(out.buffer).getUint32(4096 + 33 * 4)).toBe(1234);
    expect(out[3 * 4096 + 4]).toBe(2); // 書き換えたチャンクは zlib（ここでは恒等の圧縮）
  });

  it("reads omitted scores as zero only for valid score entries", () => {
    const row = (fields: Record<string, ReturnType<typeof nbt.string> | ReturnType<typeof nbt.int>>) => nbt.compound(fields);
    const sb = nbt.compound({ data: nbt.compound({ PlayerScores: nbt.list("compound", [
      row({ Objective: nbt.string("t"), Name: nbt.string("zero") }),
      row({ Objective: nbt.string("t"), Name: nbt.string("explicit"), Score: nbt.int(0) }),
      row({ Objective: nbt.string("t"), Name: nbt.string("nonzero"), Score: nbt.int(-7) }),
      row({ Objective: nbt.string("t"), Name: nbt.string("invalid"), Score: nbt.string("0") }),
      row({ Objective: nbt.string("t") }),
      row({ Name: nbt.string("missing-objective") }),
    ]) }) });
    expect(readScoreboard(sb)).toEqual([{ objective: "t", scores: [
      { participant: "zero", score: 0 }, { participant: "explicit", score: 0 }, { participant: "nonzero", score: -7 },
    ] }]);
  });

  it("reads scoreboard and command storage", () => {
    const sb = nbt.compound({
      data: nbt.compound({
        Objectives: nbt.list("compound", [nbt.compound({ Name: nbt.string("t") }), nbt.compound({ Name: nbt.string("empty") })]),
        PlayerScores: nbt.list("compound", [nbt.compound({ Objective: nbt.string("t"), Name: nbt.string("#a"), Score: nbt.int(42) })]),
      }),
    });
    expect(readScoreboard(sb)).toEqual([
      { objective: "t", scores: [{ participant: "#a", score: 42 }] },
      { objective: "empty", scores: [] },
    ]);
    const st = nbt.compound({ data: nbt.compound({ contents: nbt.compound({ s: nbt.compound({ b: nbt.string("x") }) }) }) });
    expect(Object.fromEntries([...readCommandStorage("je2be", st)].map(([k, v]) => [k, nbtToPlain(v)]))).toEqual({ "je2be:s": { b: "x" } });
  });
});
