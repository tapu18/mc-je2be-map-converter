import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { javaGrammarSources, loadGrammarTree, loadJavaGrammars, setupJavaGrammar, type JavaGrammarSource } from "./java-grammars.ts";

describe("grammar server source validation", () => {
  const valid: JavaGrammarSource = { version: "1.20.6", url: "https://example.invalid/server.jar", sha1: "0".repeat(40), functionDirectory: "functions" };
  it("rejects paths and invalid hashes before fetching or writing anything", async () => {
    await expect(setupJavaGrammar({ ...valid, version: "../outside" })).rejects.toThrow(/invalid grammar release/);
    await expect(setupJavaGrammar({ ...valid, sha1: "../../cache" })).rejects.toThrow(/invalid grammar server SHA/);
    await expect(setupJavaGrammar({ ...valid, url: "http://example.invalid/server.jar" })).rejects.toThrow(/HTTPS/);
  });
});

it.each([false, true])("loads copied grammars with legacy paths: %s", (legacy) => {
  const temp = mkdtempSync(join(tmpdir(), "grammar-move-"));
  try {
    const original = join(temp, "original", "servers", "grammars");
    const copied = join(temp, "copied", "servers", "grammars");
    const source = javaGrammarSources()[0]!;
    const reports = join(original, source.version, "generated", "reports");
    mkdirSync(reports, { recursive: true });
    const commands = JSON.stringify({ type: "root", children: {} });
    writeFileSync(join(reports, "commands.json"), commands);
    writeFileSync(join(original, source.version, "grammar.json"), JSON.stringify({
      version: source.version, source, dataVersion: 1, packFormat: 1, packMinor: 0,
      textFormat: "json", commandsSha256: createHash("sha256").update(commands).digest("hex"),
      ...(legacy ? { java: "/missing/java", serverDirectory: "/missing/server", commandsPath: "/missing/commands.json" } : {}),
    }));
    cpSync(original, copied, { recursive: true });
    rmSync(join(temp, "original"), { recursive: true });
    const [grammar] = loadJavaGrammars(copied);
    expect(grammar!.commandsPath).toBe(join(copied, source.version, "generated", "reports", "commands.json"));
    expect(grammar!.serverDirectory).toBe(join(copied, source.version, "server"));
    expect(grammar!.java).toBe(join(temp, "copied", "servers", "jre", "bin", "java"));
    expect(loadGrammarTree(grammar!)).toEqual(JSON.parse(commands));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
