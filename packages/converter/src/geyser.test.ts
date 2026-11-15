import { describe, expect, it } from "vitest";
import { nbt, type NbtCompound } from "@je2be/core";
import { normalizeGeyserMappings, verifyMappingSource } from "./geyser.ts";

// 最小の独自 fixture。Geyser のゲームデータをテストに複写しない。
const root = (): NbtCompound => nbt.compound({
  bedrock_mappings: nbt.list("compound", [
    nbt.compound({}),
    nbt.compound({ bedrock_identifier: nbt.string("brick_block"), state: nbt.compound({
      flag: nbt.byte(1), direction: nbt.int(3), kind: nbt.string("test"),
    }) }),
  ]),
});
const report = () => ({
  "minecraft:bricks": { properties: { facing: ["east"] }, states: [{ id: 1, properties: { facing: "east" } }] },
  "minecraft:air": { states: [{ id: 0 }] },
});

describe("Geyser normalization", () => {
  it("joins by JE numeric state ID, restores omitted names, and preserves NBT state types", () => {
    const tables = normalizeGeyserMappings(root(), {
      "minecraft:bricks": { bedrock_identifier: "minecraft:brick_block", bedrock_data: 4, firstBlockRuntimeId: 100, component: "not copied" },
    }, report());
    expect(tables).toEqual({
      blocks: [
        { java: { id: "minecraft:air", states: {} }, bedrock: { id: "minecraft:air", states: {} } },
        { java: { id: "minecraft:bricks", states: { facing: "east" } }, bedrock: { id: "minecraft:brick_block", states: { direction: 3, flag: true, kind: "test" } } },
      ],
      items: [{ javaId: "minecraft:bricks", bedrockId: "minecraft:brick_block", data: 4 }],
    });
    const reversed = Object.fromEntries(Object.entries(report()).reverse());
    expect(JSON.stringify(normalizeGeyserMappings(root(), {}, reversed))).toBe(JSON.stringify(normalizeGeyserMappings(root(), {}, report())));
  });

  it("rejects mismatched versions/counts, duplicate IDs and missing properties", () => {
    expect(() => normalizeGeyserMappings(root(), {}, { "minecraft:air": { states: [{ id: 0 }] } })).toThrow(/count mismatch/);
    expect(() => normalizeGeyserMappings(root(), {}, {
      "minecraft:air": { states: [{ id: 0 }, { id: 0 }] },
    })).toThrow(/duplicate JE state ID/);
    const incomplete = report();
    incomplete["minecraft:bricks"].states[0]!.properties = {} as { facing: string };
    expect(() => normalizeGeyserMappings(root(), {}, incomplete)).toThrow(/incomplete JE properties/);
  });

  it("rejects unsupported NBT state types, malformed identifiers and invalid item data", () => {
    const bad = nbt.compound({ bedrock_mappings: nbt.list("compound", [nbt.compound({}), nbt.compound({ state: nbt.compound({ v: nbt.long(1n) }) })]) });
    expect(() => normalizeGeyserMappings(bad, {}, report())).toThrow(/unsupported Bedrock state type/);
    expect(() => normalizeGeyserMappings(root(), { "minecraft:a": { bedrock_identifier: "geyseropt:a" } }, report())).toThrow(/invalid vanilla identifier/);
    expect(() => normalizeGeyserMappings(root(), { "minecraft:a": { bedrock_identifier: "minecraft:a", bedrock_data: -1 } }, report())).toThrow(/invalid item data/);
  });

  it("fails checksum verification for corrupt sources and a different JE report", () => {
    for (const name of ["blocks.nbt", "items.json", "LICENSE", "java-blocks.json"] as const) {
      expect(() => verifyMappingSource(name, new Uint8Array([0]))).toThrow(/SHA-256 mismatch/);
    }
  });
});
