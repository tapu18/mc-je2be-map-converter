import { describe, expect, it } from "vitest";
import { RuntimeState } from "../../core/src/runtime/command.ts";
import { commitState, restoreOrInitialize, restoreState, splitUtf8, type Properties } from "./persistence.ts";

class Fake implements Properties {
  values = new Map<string, string>();
  fail = false;
  get(key: string) { return this.values.get(key); }
  set(key: string, value?: string) {
    if (this.fail && key === "je2be:state:commit") throw Error("capacity");
    if (value === undefined) this.values.delete(key); else this.values.set(key, value);
  }
}
function sample() {
  const state = new RuntimeState(); state.scores.addObjective("points"); state.scores.set("alice", "points", -42);
  state.storage.values.set("test:data", {type: "compound", value: new Map([["text", {type: "string", value: "🌍".repeat(12000)}]])});
  return state;
}
describe("committed runtime state", () => {
  it("round trips scores and large typed storage in UTF-8 bounded chunks", () => {
    const fake = new Fake(), state = sample(); commitState(fake, state);
    expect(restoreState(fake)).toEqual(state);
    const chunks = [...fake.values].filter(([k]) => k !== "je2be:state:commit");
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every(([, value]) => Buffer.byteLength(value) <= 32767)).toBe(true);
    expect(splitUtf8("🌍".repeat(10000)).length).toBe(2);
  });
  it("ignores an uncommitted partial generation", () => {
    const fake = new Fake(), state = sample(); commitState(fake, state);
    state.scores.set("alice", "points", 5); fake.fail = true;
    expect(() => commitState(fake, state)).toThrow("capacity");
    expect(restoreState(fake)?.scores.get("alice", "points")).toBe(-42);
  });
  it("commits initial state once without overwriting a committed generation", () => {
    const fake = new Fake(); expect(restoreOrInitialize(fake, sample)).toEqual(sample());
    expect(restoreOrInitialize(fake, () => { throw Error("initial values used"); })).toEqual(sample());
  });
});
