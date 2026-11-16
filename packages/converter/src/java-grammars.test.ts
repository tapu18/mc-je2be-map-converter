import { describe, expect, it } from "vitest";
import { setupJavaGrammar, type JavaGrammarSource } from "./java-grammars.ts";

describe("grammar server source validation", () => {
  const valid: JavaGrammarSource = { version: "1.20.6", url: "https://example.invalid/server.jar", sha1: "0".repeat(40), functionDirectory: "functions" };
  it("rejects paths and invalid hashes before fetching or writing anything", async () => {
    await expect(setupJavaGrammar({ ...valid, version: "../outside" })).rejects.toThrow(/invalid grammar release/);
    await expect(setupJavaGrammar({ ...valid, sha1: "../../cache" })).rejects.toThrow(/invalid grammar server SHA/);
    await expect(setupJavaGrammar({ ...valid, url: "http://example.invalid/server.jar" })).rejects.toThrow(/HTTPS/);
  });
});
