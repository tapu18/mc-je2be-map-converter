import { describe, expect, it } from "vitest";
import { CommandParser, MappingLookup, type RewriteContext } from "@je2be/core";
import { staticCommandCoverage } from "./static-coverage.ts";

const context: RewriteContext = {
  parser: new CommandParser({ type: "root", children: {
    say: { type: "literal", children: { message: { type: "argument", parser: "minecraft:message", executable: true } } },
    function: { type: "literal", children: { name: { type: "argument", parser: "minecraft:resource_location", executable: true } } },
  } }, { textFormat: "snbt" }),
  mappings: new MappingLookup({ schemaVersion: 1, source: { repository: "fixture", revision: "fixture", javaVersion: "test", bedrockVersion: "test", sha256: {} }, blocks: [], items: [] }),
  blockDefaults: () => undefined,
};

describe("static coverage boundaries", () => {
  it("separates command output capability from function runtime routing", () => {
    expect(staticCommandCoverage("say hello", "cb", context)).toMatchObject({ status: "unchanged", route: "native-candidate" });
    expect(staticCommandCoverage("say hello", "fn", context)).toMatchObject({ status: "unchanged", route: "runtime-required" });
    expect(staticCommandCoverage("function private:secret", "cb", context)).toMatchObject({ status: "unsupported", route: "runtime-required" });
  });
  it("never publishes argument values or diagnostics as unsupported patterns", () => {
    const a = staticCommandCoverage("function private:secret", "fn", context);
    const b = staticCommandCoverage("function other:confidential", "fn", context);
    expect(a).toEqual(b);
    expect(a.pattern).toBe("function <minecraft:resource_location>");
    expect(JSON.stringify(a)).not.toMatch(/private|secret|confidential/);
  });
  it("keeps missing grammars, syntax failures and runtime macros distinct", () => {
    expect(staticCommandCoverage("say hello", "cb")).toMatchObject({ status: "unavailable", route: "unresolved" });
    expect(staticCommandCoverage("not-a-command private", "cb", context)).toEqual({ status: "invalid", route: "unresolved", warnings: false });
    expect(staticCommandCoverage("$say $(private)", "fn")).toEqual({ status: "macro", route: "runtime-required", warnings: false });
  });
});
