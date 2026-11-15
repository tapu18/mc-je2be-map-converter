import { describe, expect, it } from "vitest";
import { blockStateKey, MappingLookup, type MappingTables } from "./mappings.ts";

function tables(): MappingTables {
  return {
    schemaVersion: 1,
    source: { repository: "test", revision: "test", javaVersion: "test", bedrockVersion: "test", sha256: {} },
    blocks: [
      ...["false", "true"].map((waterlogged) => ({
        java: { id: "minecraft:oak_stairs", states: { facing: "east", half: "top", waterlogged } },
        bedrock: { id: "minecraft:oak_stairs", states: { weirdo_direction: 0, upside_down_bit: true } },
      })),
      { java: { id: "minecraft:stone", states: {} }, bedrock: { id: "minecraft:stone", states: {} } },
    ],
    items: [
      { javaId: "minecraft:arrow", bedrockId: "minecraft:arrow" },
      { javaId: "minecraft:test_arrow", bedrockId: "minecraft:arrow", data: 0 },
      { javaId: "minecraft:tipped_arrow", bedrockId: "minecraft:arrow", data: 5 },
    ],
  };
}

describe("mapping lookup", () => {
  it("matches complete states regardless of order and identifies collapsed/waterlogged states", () => {
    const lookup = new MappingLookup(tables());
    expect(lookup.block("minecraft:oak_stairs", { waterlogged: "true", half: "top", facing: "east" })).toEqual({
      status: "mapped", target: { id: "minecraft:oak_stairs", states: { weirdo_direction: 0, upside_down_bit: true } },
      sharedBy: 2, waterlogged: true, verification: "unverified",
    });
    expect(lookup.block("minecraft:stone")).toMatchObject({ status: "mapped", sharedBy: 1, waterlogged: false });
  });

  it("does not silently default partial conditions or pass through unsupported states", () => {
    const lookup = new MappingLookup(tables());
    expect(lookup.block("minecraft:oak_stairs", { facing: "east" })).toEqual({ status: "incomplete-state" });
    expect(lookup.block("minecraft:oak_stairs", { facing: "west", half: "top", waterlogged: "false" })).toEqual({ status: "unknown-state" });
    expect(lookup.block("minecraft:stone", { invalid: "x" })).toEqual({ status: "unknown-state" });
    expect(lookup.block("custom:stone")).toEqual({ status: "unknown-block" });
    expect(blockStateKey({ id: "minecraft:stone", states: { bit: true } })).not.toBe(blockStateKey({ id: "minecraft:stone", states: { bit: "true" } }));
  });

  it("keeps item data and distinguishes variants while reporting shared targets", () => {
    const lookup = new MappingLookup(tables());
    expect(lookup.item("minecraft:arrow")).toMatchObject({ sharedBy: 2, verification: "unverified" });
    expect(lookup.item("minecraft:tipped_arrow")).toMatchObject({ target: { bedrockId: "minecraft:arrow", data: 5 }, sharedBy: 1 });
    expect(lookup.item("custom:arrow")).toEqual({ status: "unknown-item" });
  });

  it("rejects duplicate source rows rather than choosing one silently", () => {
    const blocks = tables();
    blocks.blocks.push(blocks.blocks[0]!);
    expect(() => new MappingLookup(blocks)).toThrow(/duplicate Java block state/);
    const items = tables();
    items.items.push(items.items[0]!);
    expect(() => new MappingLookup(items)).toThrow(/duplicate Java item/);
  });
});
