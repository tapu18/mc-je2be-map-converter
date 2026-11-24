import {readFileSync} from "node:fs";
import {expect, it} from "vitest";
import {CommandParser, executeCommand, nbtToPlain, RuntimeState, toCommandIR, type CommandTreeNode} from "@je2be/core";
import {paths} from "../paths.ts";
import {runJava} from "./run.ts";
import type {Scenario} from "./types.ts";

it("matches Java function conditions for explicit return values and ordinary functions", async () => {
  const scenario: Scenario = {
    description: "Function conditions and return values",
    setup: ["scoreboard objectives add result dummy"],
    datapack: {functions: {"m2:zero": ["return 0"], "m2:negative": ["return -1"], "m2:fail": ["return fail"], "m2:normal": ["scoreboard players set #inside result 2"]}},
    actions: ["zero", "negative", "fail", "normal"].flatMap(n => [
      {run: `execute if function m2:${n} run scoreboard players set #${n} result 1`},
      {run: `execute unless function m2:${n} run scoreboard players set #unless_${n} result 1`},
    ]),
    observe: {scores: ["result"]},
  };
  const java = await runJava(scenario);
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const parse = (line: string) => { const parsed = parser.parse(line); if (!parsed.ok) throw new Error(parsed.error.message); return toCommandIR(line, parsed.nodes); };
  const state = new RuntimeState();
  for (const [name, lines] of Object.entries(scenario.datapack!.functions)) state.functions.set(name, lines.map(parse));
  for (const line of scenario.setup) executeCommand(state, parse(line));
  for (const action of scenario.actions) if ("run" in action) executeCommand(state, parse(action.run));
  expect(Object.fromEntries(state.scores.objectives.get("result")!)).toEqual(java.state.scores?.result);
});

it("matches Java's function tag results and condition short circuit", async () => {
  const scenario: Scenario = {
    description: "Function tag returns",
    setup: ["scoreboard objectives add result dummy", "data modify storage m2:test trace set value []"],
    datapack: {functions: {
      "m2:a": ['data modify storage m2:test trace append value "a"', "return 7"],
      "m2:b": ['data modify storage m2:test trace append value "b"', "return 4"],
    }, functionTags: {"m2:both": {values: ["m2:a", "m2:b"]}}},
    actions: [
      {run: "execute store result score #value result store success score #success result run function #m2:both"},
      {run: "execute if function #m2:both run scoreboard players set #condition result 1"},
    ],
    observe: {scores: ["result"], storage: ["m2:test"]},
  };
  const java = await runJava(scenario);
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const parse = (line: string) => { const parsed = parser.parse(line); if (!parsed.ok) throw new Error(parsed.error.message); return toCommandIR(line, parsed.nodes); };
  const state = new RuntimeState();
  for (const [name, lines] of Object.entries(scenario.datapack!.functions)) state.functions.set(name, lines.map(parse));
  state.functionTags.set("m2:both", ["m2:a", "m2:b"]);
  for (const line of scenario.setup) executeCommand(state, parse(line));
  for (const action of scenario.actions) if ("run" in action) executeCommand(state, parse(action.run));
  expect(Object.fromEntries(state.scores.objectives.get("result")!)).toEqual(java.state.scores?.result);
  expect(nbtToPlain(state.storage.get("m2:test"))).toEqual(java.state.storage?.["m2:test"]);
});
