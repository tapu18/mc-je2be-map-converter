import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CommandParser, executeScoreCommand, Scoreboard, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { paths } from "./paths.ts";

it("executes the score-operations scenario through CommandIR against Java's recorded state", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, { textFormat: "snbt" });
  const scenario = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/score-operations.json", import.meta.url), "utf8"));
  const expected = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/score-operations.java.json", import.meta.url), "utf8"));
  const scores = new Scoreboard();
  const lines: string[] = [...scenario.setup, ...scenario.datapack.functions["m2:scores/operations"]];
  for (const line of lines) {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(`${line}: ${parsed.error.message}`);
    const ir = toCommandIR(line, parsed.nodes);
    expect(ir.command, line).toBeDefined();
    expect(executeScoreCommand(scores, ir.command!), line).toMatchObject({ success: true });
  }
  expect(Object.fromEntries(scores.objectives.get("arithmetic")!)).toEqual(expected.state.scores.arithmetic);
});
