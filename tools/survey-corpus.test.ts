import { describe, expect, it } from "vitest";
import { parseSnbt } from "@je2be/core";
import { publicPath, compoundPaths, functionSummary } from "./survey-corpus.ts";

describe("private corpus aggregation", () => {
  it("redacts custom keys, storage names, indices and filter values", () => {
    const path = [{ kind: "key", key: "Inventory" }, { kind: "index", index: 42 },
      { kind: "key", key: "author-secret" }, { kind: "filter", filter: parseSnbt('{Name:"private text"}') }] as const;
    expect(publicPath([...path])).toBe("Inventory[].<custom>{…}");
    expect(publicPath([...path], true)).toBe("<custom>[].<custom>{…}");
    expect(compoundPaths(parseSnbt('{Inventory:[{Slot:1b,tag:{secret:"private text"}}],Tags:["private tag"]}')))
      .toEqual(["Inventory[].Slot", "Inventory[].tag.<custom>", "Tags[]"]);
  });
  it("requires every line of a nonempty function to emit, including calls and unknown grammars", () => {
    expect(functionSummary([
      { function: 1, status: "unchanged" }, { function: 1, status: "rewritten" },
      { function: 2, status: "rewritten" }, { function: 2, status: "unsupported" },
      { function: 3, status: "unavailable" }, { status: "unchanged" },
    ])).toEqual({ nonempty: 3, allLinesOutput: 1 });
  });
});

// Exercise nested archive/pack traversal with public synthetic fixtures in the normal check.
import { execFileSync } from "node:child_process";
it("surveys ZIP datapacks and write targets without publishing custom data", () => {
  execFileSync("python3", ["scripts/test_survey_corpus.py"], { stdio: "pipe" });
});
