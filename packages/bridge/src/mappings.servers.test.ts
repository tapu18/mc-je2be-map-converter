// 固定した実データの取り込みと、代表状態を BDS が受理して保存することを確認する。
// JE と BE の挙動等価性や水没レイヤーの変換を保証するテストではない。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MappingLookup, type MappingTables, type BedrockBlockState } from "@je2be/core";
import { fetchGeyserSources, generateGeyserMappings } from "@je2be/converter";
import { BedrockServer, paths } from "./index.ts";

describe("Geyser mapping tables", () => {
  let bds: BedrockServer;
  let tables: MappingTables;
  const source = join(paths.servers, "geyser-source");
  const output = join(paths.servers, "mappings");

  beforeAll(async () => {
    await fetchGeyserSources(source);
    tables = generateGeyserMappings(source, paths.blocksReport, output);
    bds = await BedrockServer.start();
  });
  afterAll(async () => { await bds?.stop(); });

  it("generates reproducible tables with provenance and the upstream license", () => {
    expect(tables.blocks).toHaveLength(35723);
    expect(tables.items).toHaveLength(1658);
    const original = readFileSync(join(output, "mappings.json"));
    generateGeyserMappings(source, paths.blocksReport, output);
    expect(readFileSync(join(output, "mappings.json"))).toEqual(original);
    expect(readFileSync(join(output, "LICENSE.geyser.txt"))).toEqual(readFileSync(join(source, "LICENSE")));
    expect(readFileSync(join(output, "NOTICE.txt"), "utf8")).toContain(tables.source.revision);
    expect(tables.source.javaVersion).toBe("26.3");
    expect(tables.source.bedrockVersion).toBe("1.26.60");
  });

  it("places and reads back dry stair directions/halves, slab types, log axes and renamed blocks", async () => {
    const lookup = new MappingLookup(tables);
    const cases: { id: string; states: Record<string, string> }[] = [
      { id: "minecraft:stone", states: {} },
      { id: "minecraft:bricks", states: {} },
      ...["x", "y", "z"].map((axis) => ({ id: "minecraft:oak_log", states: { axis } })),
      ...["bottom", "top", "double"].map((type) => ({ id: "minecraft:oak_slab", states: { type, waterlogged: "false" } })),
    ];
    for (const facing of ["north", "south", "east", "west"])
      for (const half of ["bottom", "top"])
        cases.push({ id: "minecraft:oak_stairs", states: { facing, half, shape: "straight", waterlogged: "false" } });
    for (const [i, input] of cases.entries()) {
      const row = lookup.block(input.id, input.states);
      expect(row.status, JSON.stringify(input)).toBe("mapped");
      if (row.status !== "mapped") throw new Error(`missing case: ${input.id}`);
      const x = (i % 8) * 6 + 1, z = Math.floor(i / 8) * 6 + 1;
      const states = Object.entries(row.target.states).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(",");
      const set = await bds.exec(`setblock ${x} -50 ${z} ${row.target.id} [${states}]`);
      expect(set, JSON.stringify(input)).toMatchObject({ ok: true, result: { successCount: 1 } });
      const read = await bds.request<{ type: string; states: BedrockBlockState["states"] }[]>("blocks", { from: [x, -50, z] });
      expect(read.ok).toBe(true);
      // Geyser が省略した値を BDS が補う場合がある（stone_type=stone 等）。
      expect(read.result?.[0], JSON.stringify(input)).toEqual(expect.objectContaining({
        type: row.target.id, states: expect.objectContaining(row.target.states),
      }));
      if (input.id === "minecraft:stone") expect(read.result?.[0]?.states).toMatchObject({ stone_type: "stone" });
    }
  });

  it("reports waterlogged collisions and item substitutions without declaring equivalence", () => {
    const lookup = new MappingLookup(tables);
    const wet = lookup.block("minecraft:oak_stairs", { facing: "east", half: "bottom", shape: "straight", waterlogged: "true" });
    const dry = lookup.block("minecraft:oak_stairs", { facing: "east", half: "bottom", shape: "straight", waterlogged: "false" });
    expect(wet).toMatchObject({ status: "mapped", waterlogged: true, verification: "unverified" });
    expect(dry).toMatchObject({ status: "mapped", waterlogged: false, verification: "unverified" });
    if (wet.status !== "mapped" || dry.status !== "mapped") throw new Error("missing stairs");
    expect(wet.target).toEqual(dry.target);
    expect(wet.sharedBy).toBeGreaterThan(1);
    expect(lookup.item("minecraft:furnace_minecart")).toMatchObject({
      status: "mapped", target: { bedrockId: "minecraft:hopper_minecart" }, sharedBy: 2, verification: "unverified",
    });
  });
});
