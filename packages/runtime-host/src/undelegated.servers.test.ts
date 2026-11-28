import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";
import { CommandParser, serializeCommandIR, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { writeInitPack } from "../../converter/src/convert.ts";

// #353: a function line without a BE command fails like a Java command; load and tick keep running.
it("keeps running load and tick functions past lines without a BE command, warning once per line", async () => {
  const dir = mkdtempSync(join(paths.servers, "runtime-undelegated-"));
  try {
    const tree = JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode;
    const parser = new CommandParser(tree, {textFormat: "snbt"});
    // No native commands are passed to the pack, so the particle lines have no delegate.
    const undelegated = "particle minecraft:flame ~ ~ ~";
    const scripts = {
      "test:load": [undelegated, "scoreboard players set #loaded clock 1"],
      "test:tick": [
        "scoreboard players add #before clock 1",
        undelegated,
        "scoreboard players set #stored clock 5",
        `execute store success score #stored clock run ${undelegated}`,
        "scoreboard players add #after clock 1",
      ],
    };
    const functions = Object.fromEntries(Object.entries(scripts).map(([id, lines]) => [id, lines.map(source => {
      const parsed = parser.parse(source);
      if (!parsed.ok) throw Error(`${source}: ${parsed.error.message}`);
      return serializeCommandIR({grammarVersion: "26.3", textFormat: "snbt", ir: toCommandIR(source, parsed.nodes)});
    })]));
    const datapacks = {schemaVersion: 1, packs: [{functions, tags: {
      "minecraft:load": {values: ["test:load"]},
      "minecraft:tick": {values: ["test:tick"]},
    }}]};
    writeInitPack(dir, [{objective: "clock", scores: [{participant: "#after", score: 0}]}], [], JSON.stringify(datapacks));

    const bds = await BedrockServer.start({behaviorPacks: [join(dir, "behavior_packs", "je2be_init")], tickingArea: false});
    try {
      const scores = async () => {
        const {result} = await bds.request<{objective: string; scores: {participant: string; score: number}[]}[]>("scores");
        return Object.fromEntries(result?.find(row => row.objective === "clock")?.scores.map(
          ({participant, score}) => [participant, score],
        ) ?? []);
      };
      await expect.poll(async () => (await scores())["#after"] ?? 0, {timeout: 30_000}).toBeGreaterThanOrEqual(3);
      const first = await scores();
      // Every line after the undelegated ones ran on each tick, and `execute store success` saw the failure.
      expect(first).toMatchObject({"#loaded": 1, "#stored": 0});
      expect(first["#before"]).toBe(first["#after"]);
      // Later ticks keep running.
      await expect.poll(async () => (await scores())["#after"] ?? 0, {timeout: 30_000}).toBeGreaterThan(first["#after"]!);

      const warnings = bds.log.filter(line => line.includes("fails without a BE command"));
      expect(warnings.filter(line => line.includes("function test:load command 1 "))).toHaveLength(1);
      expect(warnings.filter(line => line.includes("function test:tick command 2 "))).toHaveLength(1);
      expect(warnings.filter(line => line.includes("function test:tick command 4 "))).toHaveLength(1);
      expect(warnings).toHaveLength(3);
      expect(bds.log.some(line => line.includes("tick stopped") || line.includes("initialization failed"))).toBe(false);
    } finally {
      await bds.stop();
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
