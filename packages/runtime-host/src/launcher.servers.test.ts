import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";
import {
  buildMcstructure, commandBlock, CommandParser, serializeCommandIR, toCommandIR,
  type CommandTreeNode, type StructureBlock,
} from "@je2be/core";
import { writeInitPack } from "../../converter/src/convert.ts";

const compareStates = {
  "minecraft:cardinal_direction": "south", direction: 0, output_lit_bit: false, output_subtract_bit: false,
};

it("passes command block context to the runtime and reports synchronous success to BDS", async () => {
  const dir = mkdtempSync(join(paths.servers, "runtime-launcher-"));
  try {
    const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
    const scripts = {
      "test:start": [
        "execute if entity @s[tag=launcher_executor] positioned ^ ^ ^1 if entity @e[tag=launcher_target,distance=..0.2] run return run function test:write",
        "return fail",
      ],
      "test:write": [
        "data modify storage test:launcher value set value 42",
        "execute store result score observed points run data get storage test:launcher value",
        "return 0",
      ],
      "test:check": ["return run scoreboard players get observed points"],
      "test:fail": ["scoreboard players set failed_ran points 1", "return fail"],
      "test:native": ["say delegated"],
    };
    const functions = Object.fromEntries(Object.entries(scripts).map(([id, lines]) => [id, lines.map(source => {
      const parsed = parser.parse(source);
      if (!parsed.ok) throw Error(`${source}: ${parsed.error.message}`);
      return serializeCommandIR({grammarVersion: "26.3", textFormat: "snbt", ir: toCommandIR(source, parsed.nodes)});
    })]));
    writeInitPack(dir, [{objective: "points", scores: []}], [], JSON.stringify({
      schemaVersion: 1, packs: [{name: "launcher", functions, tags: {}}],
    }), "[]", [["say delegated", "scoreboard players set delegated points 1"]]);
    const pack = join(dir, "behavior_packs", "je2be_init");
    const structures = join(pack, "structures", "je2be");
    mkdirSync(structures, {recursive: true});

    const blocks: StructureBlock[] = [];
    const rows = [
      {x: 0, command: "execute as @e[tag=launcher_executor,c=1] in nether positioned 9.5 70 8.5 rotated 90 0 run je2be:run test:start ~ ~ ~ ^ ^ ^1 nether @s", chain: [
        "je2be:run test:check ~ ~ ~ ^ ^ ^1 overworld",
        "scoreboard players set success_chain points 1",
      ]},
      {x: 2, command: "je2be:run test:fail ~ ~ ~ ^ ^ ^1 overworld", chain: [
        "scoreboard players set failure_chain points 1",
      ]},
    ];
    for (const {x, command, chain} of rows) {
      blocks.push({pos: [x, 0, 0], name: "minecraft:unpowered_comparator", states: compareStates});
      blocks.push(commandBlock({pos: [x, 0, 1], kind: "impulse", command, facing: 3, alwaysActive: true}));
      for (const [index, follow] of chain.entries()) {
        blocks.push(commandBlock({pos: [x, 0, index + 2], kind: "chain", command: follow, facing: 3, conditional: true, alwaysActive: true}));
      }
    }
    writeFileSync(join(structures, "launcher.mcstructure"), buildMcstructure({size: [3, 1, 4], blocks, fillAir: true}));

    const bds = await BedrockServer.start({behaviorPacks: [pack]});
    try {
      await bds.waitForLog(line => line.includes("[je2be] initialized"), 30_000, "runtime initialization");
      const run = async (command: string, dimension?: string) => {
        expect((await bds.exec(command, dimension)).result?.successCount, command).toBe(1);
      };
      await run("tickingarea add 0 0 0 15 0 15 launcher_nether", "nether");
      await expect.poll(async () => (await bds.request<boolean>("loaded", {pos: [8, 70, 8], dimension: "nether"})).result,
        {timeout: 30_000}).toBe(true);
      await run("setblock 8 69 8 stone", "nether");
      await run("summon armor_stand 8.5 70 8.5", "nether");
      await run("tag @e[type=armor_stand,c=1] add launcher_target", "nether");
      await run("summon armor_stand 3.5 -60 3.5");
      await run("tag @e[type=armor_stand,c=1] add launcher_executor");
      await run("fill 0 -51 0 2 -51 3 stone");
      await run("structure load je2be:launcher 0 -50 0");

      const scores = async () => {
        const {result} = await bds.request<{objective: string; scores: {participant: string; score: number}[]}[]>("scores");
        return Object.fromEntries(result?.find(entry => entry.objective === "points")?.scores.map(
          ({participant, score}) => [participant, score],
        ) ?? []);
      };
      await expect.poll(scores, {timeout: 10_000}).toEqual({observed: 42, success_chain: 1, failed_ran: 1});
      const comparators = async () => {
        const {result} = await bds.request<{type: string; states: Record<string, unknown>}[]>("blocks",
          {from: [0, -50, 0], to: [2, -50, 0]});
        return result?.filter(block => block.type.includes("comparator")).map(block => block.states.output_lit_bit);
      };
      await expect.poll(comparators, {timeout: 10_000}).toEqual([true, false]);

      bds.console("je2be:run test:native 0 -50 0 0 -50 1 overworld");
      await bds.waitForLog(line => line.includes("je2be:run test:native: unknown command outcome"), 10_000, "unknown outcome");
      await run("je2be:run test:check ~ ~ ~ ^ ^ ^1 overworld");
      expect(await scores()).toEqual({observed: 42, success_chain: 1, failed_ran: 1});
    } finally {
      await bds.stop();
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
