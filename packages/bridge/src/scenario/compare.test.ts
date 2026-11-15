import { describe, expect, it } from "vitest";
import { compareStates, unexpectedDiffs } from "./compare.ts";
import { javaBlockString, minimalBlockMapper, normalizeBedrock, normalizeJava } from "./normalize.ts";

describe("scenario normalize/compare", () => {
  const observe = { scores: ["t"], blocks: [{ from: [0, 0, 0] as [number, number, number] }], entityTags: ["p"] };

  it("normalizes both editions into the same shape", () => {
    const j = normalizeJava(observe, {
      scores: [{ objective: "t", scores: [{ participant: "#a", score: 3 }] }, { objective: "other", scores: [] }],
      blocks: [{ pos: [0, 0, 0], type: "minecraft:gold_block", states: {} }],
      entities: [{ type: "minecraft:pig", tags: ["q", "p"] }, { type: "minecraft:pig", tags: ["p", "q"] }, { type: "minecraft:cow", tags: ["x"] }],
    });
    const b = normalizeBedrock(observe, {
      scores: [{ objective: "t", scores: [{ participant: "#a", score: 3 }] }],
      blocks: [{ pos: [0, 0, 0], type: "minecraft:gold_block", states: {} }],
      entities: [{ type: "minecraft:pig", tags: ["p", "q"] }, { type: "minecraft:pig", tags: ["q", "p"] }],
    });
    expect(j).toEqual(b);
    expect(j.entities).toEqual({ "minecraft:pig p,q": 2 });
    expect(compareStates(j, b)).toEqual({ diffs: [], incomparable: [] });
  });

  it("reports differences, missing values, and unmapped blocks", () => {
    const j = normalizeJava(observe, {
      scores: [{ objective: "t", scores: [{ participant: "#a", score: 3 }, { participant: "#b", score: 1 }] }],
      blocks: [{ pos: [0, 0, 0], type: "minecraft:oak_stairs", states: { half: "top", facing: "east" } }],
      entities: [],
    });
    const b = normalizeBedrock(observe, {
      scores: [{ objective: "t", scores: [{ participant: "#a", score: 4 }] }],
      blocks: [{ pos: [0, 0, 0], type: "minecraft:oak_stairs", states: { weirdo_direction: 0 } }],
      entities: [{ type: "minecraft:pig", tags: ["p"] }],
    });
    const r = compareStates(j, b);
    expect(r.diffs).toEqual([
      { path: "scores.t.#a", java: 3, bedrock: 4 },
      { path: "scores.t.#b", java: 1, bedrock: undefined },
      { path: "entities.minecraft:pig p", java: undefined, bedrock: 1 },
    ]);
    expect(r.incomparable).toEqual(['blocks.0,0,0: minecraft:oak_stairs{"weirdo_direction":0}']);
    expect(unexpectedDiffs(r, { "scores.t.#b": "調査済み" }).map((d) => d.path)).toEqual(["scores.t.#a", "entities.minecraft:pig p"]);
  });

  it("formats Java block states in a stable order", () => {
    expect(javaBlockString("minecraft:oak_stairs", { half: "top", facing: "east" })).toBe("minecraft:oak_stairs[facing=east,half=top]");
    expect(minimalBlockMapper("minecraft:stone", {})).toBeUndefined();
    expect(minimalBlockMapper("minecraft:gold_block", {})).toBe("minecraft:gold_block");
  });
});
