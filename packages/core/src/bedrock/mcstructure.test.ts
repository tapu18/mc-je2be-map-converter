import { describe, expect, it } from "vitest";
import { readNbt, type NbtTag } from "../nbt/nbt.ts";
import { buildMcstructure, commandBlock } from "./mcstructure.ts";

const get = (t: NbtTag, ...path: string[]): NbtTag => {
  let cur = t;
  for (const p of path) {
    if (cur.type !== "compound") throw new Error(`not a compound at ${p}`);
    const next = cur.value.get(p);
    if (!next) throw new Error(`missing ${p}`);
    cur = next;
  }
  return cur;
};
const ints = (t: NbtTag): number[] => (t.type === "list" ? t.value.map((v) => (v.type === "int" ? v.value : NaN)) : []);

describe("mcstructure", () => {
  it("lays out blocks with z varying fastest and dedupes the palette", () => {
    const bytes = buildMcstructure({
      size: [2, 2, 3],
      blocks: [
        { pos: [0, 0, 1], name: "minecraft:stone" },
        { pos: [1, 1, 2], name: "minecraft:stone" },
        { pos: [1, 0, 0], name: "minecraft:oak_stairs", states: { weirdo_direction: 2, upside_down_bit: true } },
      ],
    });
    const { tag } = readNbt(bytes, "bedrock");
    expect(ints(get(tag, "size"))).toEqual([2, 2, 3]);
    const layers = get(tag, "structure", "block_indices");
    if (layers.type !== "list") throw new Error();
    const l0 = ints(layers.value[0]!);
    // index = (x * sy + y) * sz + z
    expect(l0).toEqual([0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    expect(ints(layers.value[1]!)).toEqual(new Array(12).fill(-1));
    const palette = get(tag, "structure", "palette", "default", "block_palette");
    if (palette.type !== "list") throw new Error();
    expect(palette.value).toHaveLength(3);
    expect(get(palette.value[2]!, "states", "upside_down_bit")).toEqual({ type: "byte", value: 1 });
  });

  it("stores command block entity data at its index", () => {
    const bytes = buildMcstructure({
      size: [1, 1, 2],
      blocks: [commandBlock({ pos: [0, 0, 1], kind: "chain", command: "say hi", facing: 3, conditional: true, alwaysActive: true })],
    });
    const { tag } = readNbt(bytes, "bedrock");
    const be = get(tag, "structure", "palette", "default", "block_position_data", "1", "block_entity_data");
    expect(get(be, "Command")).toEqual({ type: "string", value: "say hi" });
    expect(get(be, "LPCommandMode")).toEqual({ type: "int", value: 2 });
    expect(get(be, "auto")).toEqual({ type: "byte", value: 1 });
    expect(get(be, "z")).toEqual({ type: "int", value: 1 });
  });

  it("rejects blocks outside the structure", () => {
    expect(() => buildMcstructure({ size: [1, 1, 1], blocks: [{ pos: [1, 0, 0], name: "minecraft:stone" }] })).toThrow(/out of bounds/);
  });
});
