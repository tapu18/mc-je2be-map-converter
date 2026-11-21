import { expect, it } from "vitest";
import { bedrockButton, geyserBlockMapper, javaButton, toPlaytest } from "./playtest.ts";
import { loadScenarios } from "./scenario/load.ts";
import type { Scenario } from "./scenario/types.ts";

const base = (play: NonNullable<Scenario["play"]>): Scenario => ({
  id: "convert/x", description: "", setup: ["scoreboard objectives add t dummy"],
  actions: [{ commandBlocks: [{ pos: [2, -60, 2], kind: "impulse", facing: "south", alwaysActive: false, command: "say a" }] }],
  play, observe: { scores: ["t"] }, requiredObservations: ["scores.t"],
});

it("turns redstone triggers into buttons and other play commands into a prep chain", () => {
  const p = toPlaytest(base([{ run: "summon minecraft:armor_stand 10 -60 4" }, { ticks: 2 }, { run: "setblock 2 -60 1 minecraft:redstone_block" }, { ticks: 5 }]));
  expect(p.steps.map((s) => [s.button.label, s.button.pos, s.button.facing])).toEqual([["準備", [0, -60, 1], "north"], ["実行1", [2, -60, 1], "north"]]);
  expect(p.actions[1]).toEqual({ commandBlocks: [
    { pos: [0, -60, 2], kind: "impulse", facing: "south", alwaysActive: false, command: "summon minecraft:armor_stand 10 -60 4" },
    { pos: [0, -60, 3], kind: "chain", facing: "south", alwaysActive: true, command: "scoreboard objectives setdisplay sidebar t" },
  ] });
  expect(p.actions.slice(2)).toEqual([
    { run: "setblock 0 -60 1 minecraft:stone_button[face=wall,facing=north,powered=false]" },
    { run: "setblock 2 -60 1 minecraft:stone_button[face=wall,facing=north,powered=false]" },
  ]);
  expect(p.buttonObserve).toEqual({ blocks: [{ from: [0, -60, 1] }, { from: [2, -60, 1] }] });
  expect(p.observe).toEqual({ scores: ["t"] });
  expect(p.requiredObservations).toEqual(["scores.t"]);
});

it("rejects play steps it cannot turn into buttons", () => {
  expect(() => toPlaytest(base([{ run: "say only" }]))).toThrow(/起動がない/);
  expect(() => toPlaytest(base([{ run: "setblock 2 -60 1 minecraft:redstone_block" }, { run: "say late" }]))).toThrow(/起動の後/);
  // 隣にインパルスがない redstone_block は起動ではなく準備として扱い、起動がないので失敗する
  expect(() => toPlaytest(base([{ run: "setblock 9 -60 9 minecraft:redstone_block" }]))).toThrow(/起動がない/);
});

it("writes pressed and released buttons for both editions", () => {
  const wall = { label: "x", pos: [0, 0, 0] as [number, number, number], facing: "north" as const };
  expect(javaButton(wall, true)).toBe("minecraft:stone_button[face=wall,facing=north,powered=true]");
  expect(bedrockButton(wall, true)).toBe('stone_button ["facing_direction"=2,"button_pressed_bit"=true]');
  expect(javaButton({ ...wall, facing: "up" }, false)).toBe("minecraft:stone_button[face=floor,facing=north,powered=false]");
});

it("maps Bedrock states back to Java only when the table is unambiguous", () => {
  const row = (java: [string, Record<string, string>], bedrock: [string, Record<string, string | number | boolean>]) =>
    ({ java: { id: java[0], states: java[1] }, bedrock: { id: bedrock[0], states: bedrock[1] } });
  const map = geyserBlockMapper({ blocks: [
    row(["minecraft:stone_button", { face: "wall", facing: "north", powered: "false" }], ["minecraft:stone_button", { facing_direction: 2, button_pressed_bit: false }]),
    row(["minecraft:stone_button", { face: "floor", facing: "north", powered: "false" }], ["minecraft:stone_button", { facing_direction: 1, button_pressed_bit: false }]),
    row(["minecraft:stone_button", { face: "floor", facing: "east", powered: "false" }], ["minecraft:stone_button", { facing_direction: 1, button_pressed_bit: false }]),
  ] } as never);
  expect(map("minecraft:stone_button", { facing_direction: 2, button_pressed_bit: false })).toBe("minecraft:stone_button[face=wall,facing=north,powered=false]");
  expect(map("minecraft:stone_button", { facing_direction: 1, button_pressed_bit: false })).toBeUndefined();
  expect(map("minecraft:unknown", {})).toBeUndefined();
});

it("turns every convert scenario into a playtest", () => {
  const converts = loadScenarios().filter((s) => s.play);
  expect(converts.length).toBeGreaterThan(0);
  for (const s of converts) expect(toPlaytest(s).steps.length, s.id).toBeGreaterThan(0);
});
