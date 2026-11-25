import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CommandParser, executeCommand, nbtToPlain, RuntimeState, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { paths } from "./paths.ts";

it("executes storage-paths actions through CommandIR and matches Java's recorded state", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const scenario = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/storage-paths.json", import.meta.url), "utf8"));
  const expected = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/storage-paths.java.json", import.meta.url), "utf8"));
  const state = new RuntimeState();
  const lines: string[] = [...scenario.setup, ...scenario.actions.map((a: {run: string}) => a.run)];
  for (const line of lines) {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(`${line}: ${parsed.error.message}`);
    expect(executeCommand(state, toCommandIR(line, parsed.nodes)), line).toMatchObject({success: true});
  }
  expect(nbtToPlain(state.storage.get("m2:probe"))).toEqual(expected.state.storage["m2:probe"]);
});

it("validates execute chains before modifying storage", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const state = new RuntimeState();
  const source = "execute if data storage m2:probe absent as @s run data modify storage m2:probe x set value 1";
  const parsed = parser.parse(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(executeCommand(state, toCommandIR(source, parsed.nodes))).toEqual({success: false, error: "unsupported execute step"});
  expect(state.storage.values.size).toBe(0);
});

it("stores results and success for chained storage operations and failed conditions", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const state = new RuntimeState();
  const run = (line: string) => {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return executeCommand(state, toCommandIR(line, parsed.nodes));
  };
  expect(run("execute store result storage test:chain result int 1 store success storage test:chain success int 1 run data modify storage test:chain value set value 5")).toMatchObject({success: true});
  expect(run("execute store success storage test:chain failed int 1 if data storage test:chain absent run data remove storage test:chain value")).toMatchObject({success: false});
  expect(nbtToPlain(state.storage.get("test:chain"))).toEqual({value: 5, result: 1, success: 1, failed: 0});
});

it("stores score results and evaluates score ranges", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const state = new RuntimeState();
  const run = (line: string) => {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return executeCommand(state, toCommandIR(line, parsed.nodes));
  };
  expect(run("scoreboard objectives add result dummy").success).toBe(true);
  expect(run("execute store result score #value result store success score #success result run scoreboard players set #source result 7").success).toBe(true);
  expect(run("execute if score #value result matches 7..8 run scoreboard players set #matched result 1").success).toBe(true);
  expect(run("execute unless score #value result matches 7 run scoreboard players set #matched result 2").success).toBe(false);
  expect(run("execute if score #value result > #success result run scoreboard players set #comparison result 1").success).toBe(true);
  expect(run("execute unless score #missing result = #value result run scoreboard players set #missing_check result 1").success).toBe(true);
  expect(state.scores.get("#value", "result")).toBe(7);
  expect(state.scores.get("#success", "result")).toBe(1);
  expect(state.scores.get("#matched", "result")).toBe(1);
  expect(state.scores.get("#comparison", "result")).toBe(1);
  expect(state.scores.get("#missing_check", "result")).toBe(1);
});

it("matches the calls scenario against Java except executor expansion", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const scenario = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/calls.json", import.meta.url), "utf8"));
  const expected = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/calls.java.json", import.meta.url), "utf8"));
  const state = new RuntimeState();
  const parse = (line: string) => {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(`${line}: ${parsed.error.message}`);
    return toCommandIR(line, parsed.nodes);
  };
  for (const [name, lines] of Object.entries(scenario.datapack.functions) as [string, string[]][]) state.functions.set(name, lines.map(parse));
  for (const [name, tag] of Object.entries(scenario.datapack.functionTags) as [string, {values: string[]}][]) state.functionTags.set(name, tag.values);
  for (const line of scenario.setup as string[]) expect(executeCommand(state, parse(line)).success, line).toBe(true);
  // The marker setup and the last two actions require entity selection and execution contexts (#231, #262).
  const knownDiffs = {"actions.executorExpansion": "未実装（#231）", "storage.m2:calls.executors": "未実装（#231）"};
  const actions = scenario.actions as {run: string}[];
  expect(actions).toHaveLength(12);
  for (const action of actions.slice(0, 4)) executeCommand(state, parse(action.run));
  expect(actions.slice(4, 10).map(a => a.run.split(" ").slice(0, 3).join(" "))).toEqual([
    "summon minecraft:marker 13", "summon minecraft:marker 9", "summon minecraft:marker 11",
    "scoreboard players set", "scoreboard players set", "scoreboard players set",
  ]);
  for (const action of actions.slice(10)) {
    expect(action.run).toMatch(/^execute positioned 8 -60 8 as @e\[type=marker,tag=worker,sort=(nearest|furthest)\] run function m2:calls\/executor$/);
    expect(executeCommand(state, parse(action.run))).toEqual({success: false, error: "unsupported execute step"});
  }
  expect(knownDiffs["actions.executorExpansion"]).toBe("未実装（#231）");
  expect(Object.fromEntries(state.scores.objectives.get("result")!)).toEqual(expected.state.scores.result);
  const actual = nbtToPlain(state.storage.get("m2:calls")) as Record<string, unknown>;
  const golden = expected.state.storage["m2:calls"] as Record<string, unknown>;
  expect(actual.executors).not.toEqual(golden.executors);
  expect(knownDiffs["storage.m2:calls.executors"]).toBe("未実装（#231）");
  const {executors: _actualExecutors, ...actualComparable} = actual;
  const {executors: _goldenExecutors, ...goldenComparable} = golden;
  expect(actualComparable).toEqual(goldenComparable);
});

it("merges compound storage values recursively", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const state = new RuntimeState();
  const run = (line: string) => {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return executeCommand(state, toCommandIR(line, parsed.nodes));
  };
  expect(run("data merge storage test:paths {a:{x:1,y:2}}")).toMatchObject({success: true});
  expect(run("data merge storage test:paths {a:{x:3}}")).toMatchObject({success: true});
  expect(nbtToPlain(state.storage.get("test:paths"))).toEqual({a: {x: 3, y: 2}});
  expect(run("data merge storage test:paths {a:{x:3}}")).toMatchObject({success: false});
  expect(run("data modify storage test:paths b.list append value 3")).toMatchObject({success: true});
  expect(run("data modify storage test:paths b.object merge value {x:1}")).toMatchObject({success: true});
  expect(nbtToPlain(state.storage.get("test:paths"))).toEqual({a: {x: 3, y: 2}, b: {list: [3], object: {x: 1}}});
  expect(run('data modify storage test:paths source set value "abcdef"')).toMatchObject({success: true});
  expect(run('data modify storage test:paths dest set string storage test:paths source 1 -1')).toMatchObject({success: true});
  expect(nbtToPlain(state.storage.get("test:paths"))).toMatchObject({dest: "bcde"});
});
