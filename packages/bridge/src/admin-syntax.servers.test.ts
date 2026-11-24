// #205: parse in a false execute branch; never execute the candidate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandParser, type CommandTreeNode } from "@je2be/core";
import { describe, expect, it } from "vitest";
import { JavaServer } from "./java.ts";
import { paths } from "./paths.ts";
import { checkJavaSyntax } from "./java-syntax.ts";

const profiles = ["ban @s", "ban @s probe", "deop @s", "op @s", "pardon @s", "whitelist add @s", "whitelist remove @s"];
describe("管理コマンドの構文監査 #205", () => {
  it("偽条件で実行を避けつつ、プレイヤー限定セレクターを Java と比較する", async () => {
    const parser = new CommandParser(JSON.parse(readFileSync(join(paths.blocksReport, "..", "commands.json"), "utf8")) as CommandTreeNode, { textFormat: "snbt" });
    const java = await JavaServer.start();
    try {
      const probe = (command: string) => java.exec(`execute if entity @e[tag=je2be_absent] run ${command}`);
      expect(await probe("stop")).toBe("");
      expect(await probe("stop garbage")).toContain("Incorrect argument");
      for (const command of profiles) {
        expect(parser.parse(command).ok, command).toBe(false);
        expect(await probe(command), command).toContain("Only players may be affected");
      }
      for (const [selector, ok] of [["@s", false], ["@s[type=player]", true], ["@e", false], ["@e[type=player]", true], ["@n", false], ["@n[type=player]", true], ["@a", true], ["@p", true], ["@r", true]] as const) {
        const command = `ban ${selector}`;
        expect(parser.parse(command).ok, command).toBe(ok);
        expect(await probe(command), command).toEqual(ok ? "" : expect.stringContaining("Only players may be affected"));
      }
      expect(await java.exec("list")).toContain("players online");
    } finally { await java.stop(); }
  }, 120_000);
  it("7候補は関数文脈の checkJavaSyntax でも拒否される", async () => {
    const parser = new CommandParser(JSON.parse(readFileSync(join(paths.blocksReport, "..", "commands.json"), "utf8")) as CommandTreeNode, { textFormat: "snbt" });
    const results = await checkJavaSyntax(profiles);
    for (const result of results) expect(parser.parse(result.command).ok, result.command).toBe(result.ok);
    expect(results.every((result) => !result.ok)).toBe(true);
  }, 120_000);
});
