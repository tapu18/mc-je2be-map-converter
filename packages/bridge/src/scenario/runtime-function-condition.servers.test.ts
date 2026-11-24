import {readFileSync} from "node:fs";
import {expect, it} from "vitest";
import {CommandParser, executeCommand, RuntimeState, toCommandIR, type CommandTreeNode} from "@je2be/core";
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
