import { expect, it } from "vitest";
import { RuntimeState } from "../../core/src/runtime/command.ts";
import { loadDatapacks } from "../../core/src/runtime/datapacks.ts";

it("resolves ordered overrides, nested tags and optional references", () => {
  const state = new RuntimeState();
  loadDatapacks(state, {schemaVersion: 1, packs: [
    {functions: {"demo:a": [], "demo:b": []}, tags: {"demo:nested": {values: ["demo:a"]}, "minecraft:tick": {values: ["demo:b"]}}},
    {functions: {}, tags: {"minecraft:tick": {replace: true, values: ["#demo:nested", {id: "demo:missing", required: false}, "demo:b", "demo:a"]}}},
  ]});
  expect(state.functionTags.get("minecraft:tick")).toEqual(["demo:a", "demo:b"]);
});

it("rejects missing required references and cycles", () => {
  expect(() => loadDatapacks(new RuntimeState(), {schemaVersion: 1, packs: [{functions: {}, tags: {"x:t": {values: ["x:missing"]}}}]})).toThrow("missing function");
  expect(() => loadDatapacks(new RuntimeState(), {schemaVersion: 1, packs: [{functions: {}, tags: {"x:t": {values: ["#x:t"]}}}]})).toThrow("cyclic");
});
