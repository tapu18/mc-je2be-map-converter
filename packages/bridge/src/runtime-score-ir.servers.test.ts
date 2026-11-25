import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CommandParser, executeCommand, RuntimeState, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { paths } from "./paths.ts";

it("executes the score-operations scenario through CommandIR against Java's recorded state", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, { textFormat: "snbt" });
  const scenario = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/score-operations.json", import.meta.url), "utf8"));
  const expected = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/score-operations.java.json", import.meta.url), "utf8"));
  const state = new RuntimeState();
  const lines: string[] = [...scenario.setup, ...scenario.datapack.functions["m2:scores/operations"]];
  for (const line of lines) {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(`${line}: ${parsed.error.message}`);
    const ir = toCommandIR(line, parsed.nodes);
    expect(ir.command, line).toBeDefined();
    expect(executeCommand(state, ir), line).toMatchObject({ success: true });
  }
  expect(Object.fromEntries(state.scores.objectives.get("arithmetic")!)).toEqual(expected.state.scores.arithmetic);
});

it("rejects unsupported score and storage forms before runtime dispatch", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const state = new RuntimeState();
  for (const line of ["scoreboard objectives add test trigger", "scoreboard players set @a test 1", "data get entity @s foo", "data modify storage test:x a set from entity @s foo"]) {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(`${line}: ${parsed.error.message}`);
    expect(executeCommand(state, toCommandIR(line, parsed.nodes)), line).toMatchObject({success: false, error: "unsupported command"});
  }
  expect(state.scores.objectives.size).toBe(0);
  expect(state.storage.values.size).toBe(0);
});
