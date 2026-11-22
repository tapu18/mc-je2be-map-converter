import { describe, expect, it } from "vitest";
import { executeInstruction, type RuntimeHost } from "./index.ts";

class FakeHost implements RuntimeHost {
  scores = new Map<string, number>();
  hasObjective(objective: string): boolean { return objective === "points"; }
  setScore(holder: string, objective: string, value: number): void {
    this.scores.set(`${objective}:${holder}`, value);
  }
}

describe("runtime scoreboard set", () => {
  it("sets a score synchronously and returns its value", () => {
    const host = new FakeHost();
    expect(executeInstruction(host, { kind: "scoreboard.players.set", holder: "#player", objective: "points", value: 42 })).toEqual({ success: true, result: 42 });
    expect(host.scores.get("points:#player")).toBe(42);
  });
  it("does not write when the objective or value is invalid", () => {
    const host = new FakeHost();
    expect(executeInstruction(host, { kind: "scoreboard.players.set", holder: "x", objective: "missing", value: 1 }).success).toBe(false);
    expect(executeInstruction(host, { kind: "scoreboard.players.set", holder: "x", objective: "points", value: 2147483648 }).success).toBe(false);
    expect(host.scores.size).toBe(0);
  });
});
