import { describe, expect, it } from "vitest";
import { assessComparison, compareStates, unexpectedDiffs } from "./compare.ts";
import { javaBlockString, minimalBlockMapper, normalizeBedrock, normalizeJava, wrapYaw } from "./normalize.ts";

describe("scenario normalize/compare", () => {
  it("fails missing or incomparable required observations while allowing investigative comparisons", () => {
    const j = { blocks: { "0,0,0": "minecraft:stone" } };
    const b = { blocks: { "0,0,0": { unmapped: "minecraft:stone" } } };
    expect(assessComparison(j, b).passed).toBe(true);
    expect(assessComparison(j, b, ["blocks"])).toMatchObject({ passed: false, completeMatch: false, required: { incomparable: 1 } });
    expect(assessComparison({}, {}, ["scores.t"])).toMatchObject({ passed: false, required: { missing: 1 } });
    expect(assessComparison({}, {}).completeMatch).toBe(false);
    expect(() => assessComparison({}, {}, [""])).toThrow();
    const absent = normalizeJava({ scores: ["t"] }, { scores: [] });
    expect(assessComparison(absent, absent, ["scores.t"]).passed).toBe(false);
  });
  it("reports known differences separately from complete required matches", () => {
    const j = { scores: { t: { a: 1 } } }, b = { scores: { t: { a: 2 } } };
    expect(assessComparison(j, b, ["scores.t"], { "scores.t.a": "known difference" })).toMatchObject({ passed: true, completeMatch: false, required: { "known-difference": 1, matched: 0 } });
    expect(assessComparison(j, j, ["scores.t"])).toMatchObject({ passed: true, completeMatch: true, required: { matched: 1 } });
    expect(assessComparison(j, b, ["scores.t"])).toMatchObject({ passed: false, required: { different: 1 } });
  });
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

  it("compares effect presence, amplifier and remaining ticks independently", () => {
    const j = { entityEffects: { pig: {
      "minecraft:speed": { amplifier: 2, duration: 235 },
      "minecraft:resistance": { amplifier: 255, duration: 235 },
      "minecraft:village_hero": { amplifier: 0, duration: -1 },
      "minecraft:glowing": { amplifier: 0, duration: 395 },
    } } };
    const b = { entityEffects: { pig: {
      "minecraft:speed": { amplifier: 2, duration: 230 },
      "minecraft:resistance": { amplifier: 254, duration: 224 },
      "minecraft:village_hero": { amplifier: 0, duration: 1 },
      "minecraft:glowing": null,
    } } };
    expect(compareStates(j, b).diffs).toEqual([
      { path: "entityEffects.pig.minecraft:resistance.amplifier", java: 255, bedrock: 254 },
      { path: "entityEffects.pig.minecraft:resistance.duration", java: 235, bedrock: 224 },
      { path: "entityEffects.pig.minecraft:village_hero.duration", java: -1, bedrock: 1 },
      { path: "entityEffects.pig.minecraft:glowing", java: { amplifier: 0, duration: 395 }, bedrock: null },
    ]);
  });

  it("normalizes entity poses by unique tag and compares them with a float tolerance", () => {
    const observe = { entityPoses: ["a", "b", "gone"] };
    const raw = [
      { type: "minecraft:armor_stand", tags: ["a"], pos: [1.25, -60, 2.5], rot: [-30, 190] },
      { type: "minecraft:armor_stand", tags: ["b"], pos: [3, -60, 4], rot: [0, -45] },
    ];
    const j = normalizeJava(observe, { entities: raw });
    expect(j.entityPoses).toEqual({ a: { pos: [1.25, -60, 2.5], rot: [-30, -170] }, b: { pos: [3, -60, 4], rot: [0, -45] }, gone: null });
    expect(wrapYaw(180)).toBe(-180);
    const b = normalizeBedrock(observe, { entities: [
      { type: "minecraft:armor_stand", tags: ["a"], pos: [1.2549, -60, 2.5], rot: [0, -170.004] },
      { type: "minecraft:armor_stand", tags: ["b", "gone"], pos: [3, -60, 4.5], rot: [0, -45] },
    ] });
    expect(compareStates(j, b).diffs).toEqual([
      { path: "entityPoses.a.rot", java: [-30, -170], bedrock: [0, -170.004] },
      { path: "entityPoses.b.pos", java: [3, -60, 4], bedrock: [3, -60, 4.5] },
      { path: "entityPoses.gone", java: null, bedrock: { pos: [3, -60, 4.5], rot: [0, -45] } },
    ]);
    expect(compareStates({ entityPoses: { a: { pos: [0, 0, 0], rot: [0, 179.999] } } }, { entityPoses: { a: { pos: [0, 0, 0], rot: [0, -180] } } }).diffs).toEqual([]);
    expect(() => normalizeJava(observe, { entities: [...raw, raw[0]!] })).toThrow(/2 体/);
  });

  it("formats Java block states in a stable order", () => {
    expect(javaBlockString("minecraft:oak_stairs", { half: "top", facing: "east" })).toBe("minecraft:oak_stairs[facing=east,half=top]");
    expect(minimalBlockMapper("minecraft:stone", {})).toBeUndefined();
    expect(minimalBlockMapper("minecraft:gold_block", {})).toBe("minecraft:gold_block");
  });
});
