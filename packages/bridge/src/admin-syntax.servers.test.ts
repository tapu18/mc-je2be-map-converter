// #205: parse in a false execute branch; never execute the candidate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandParser, type CommandTreeNode } from "@je2be/core";
import { describe, expect, it } from "vitest";
import { JavaServer } from "./java.ts";
import { paths } from "./paths.ts";

const profiles = ["ban @s", "ban @s probe", "deop @s", "op @s", "pardon @s", "whitelist add @s", "whitelist remove @s"];
describe("管理コマンドの構文監査 #205", () => {
  it("偽条件で実行を避けつつ、プレイヤー限定セレクターの不一致を再現する", async () => {
    const parser = new CommandParser(JSON.parse(readFileSync(join(paths.blocksReport, "..", "commands.json"), "utf8")) as CommandTreeNode, { textFormat: "snbt" });
    const java = await JavaServer.start();
    try {
      const probe = (command: string) => java.exec(`execute if entity @e[tag=je2be_absent] run ${command}`);
      expect(await probe("stop")).toBe("");
      expect(await probe("stop garbage")).toContain("Incorrect argument");
      for (const command of profiles) {
        expect(parser.parse(command).ok, command).toBe(true);
        expect(await probe(command), command).toContain("Only players may be affected");
      }
      expect(await java.exec("list")).toContain("players online");
    } finally { await java.stop(); }
  }, 120_000);
});
