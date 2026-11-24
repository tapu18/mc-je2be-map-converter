import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Scoreboard, type ScoreOperation } from "@je2be/core";

describe("runtime scoreboard", () => {
  it("matches the Java score-operations scenario when its function body is executed directly", () => {
    const scenario = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/score-operations.json", import.meta.url), "utf8"));
    const expected = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/score-operations.java.json", import.meta.url), "utf8"));
    const scores = new Scoreboard();
    expect(scores.addObjective("arithmetic")).toBe(true);
    for (const line of scenario.datapack.functions["m2:scores/operations"] as string[]) {
      const words = line.split(" ");
      if (words[2] === "set") expect(scores.set(words[3]!, words[4]!, Number(words[5]))).toBe(true);
      else if (words[2] === "operation") expect(scores.operation(words[3]!, words[4]!, words[5] as ScoreOperation, words[6]!, words[7]!)).not.toBeUndefined();
      else throw new Error(`Unexpected command: ${line}`);
    }
    expect(Object.fromEntries(scores.objectives.get("arithmetic")!)).toEqual(expected.state.scores.arithmetic);
  });
  it("preserves values on division by zero and distinguishes missing scores", () => {
    const scores = new Scoreboard();
    scores.addObjective("a");
    scores.set("x", "a", 7);
    scores.set("zero", "a", 0);
    expect(scores.operation("x", "a", "/=", "zero", "a")).toBeUndefined();
    expect(scores.get("x", "a")).toBe(7);
    expect(scores.get("missing", "a")).toBeUndefined();
    expect(scores.reset("zero", "a")).toBe(1);
  });
});
