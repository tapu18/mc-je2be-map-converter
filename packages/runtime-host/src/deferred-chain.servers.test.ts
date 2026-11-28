import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";
import {
  buildMcstructure, commandBlock, CommandParser, serializeCommandIR, toCommandIR,
  type CommandTreeNode, type RuntimeChain, type StructureBlock,
} from "@je2be/core";
import { writeInitPack } from "../../converter/src/convert.ts";

const compareStates = {
  "minecraft:cardinal_direction": "south", direction: 0, output_lit_bit: false, output_subtract_bit: false,
};
const origin = [0, -50, 0] as const;

// #93 decision 2: a chain whose later conditional block consumes a delegated command's outcome
// runs after this tick's command blocks, where BE reports the delegation's successCount.
it("passes a delegated command's BE success to later conditional blocks of a deferred chain", async () => {
  const dir = mkdtempSync(join(paths.servers, "runtime-deferred-chain-"));
  try {
    const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
    const ir = (source: string) => {
      const parsed = parser.parse(source);
      if (!parsed.ok) throw Error(`${source}: ${parsed.error.message}`);
      return serializeCommandIR({grammarVersion: "26.3", textFormat: "snbt", ir: toCommandIR(source, parsed.nodes)});
    };
    const rows = [
      {x: 0, label: "found", tag: "deferred_target"},
      {x: 2, label: "missing", tag: "deferred_missing"},
    ];
    const chains: Record<string, RuntimeChain> = {};
    const blocks: StructureBlock[] = [];
    for (const [index, {x, label, tag}] of rows.entries()) {
      const id = `chain@${index}`;
      const java = `tag @e[tag=${tag},limit=1] add marked_${label}`;
      const commands = [
        `scoreboard players set head_${label} points 1`,
        java,
        `scoreboard players set after_${label} points 1`,
      ];
      chains[id] = {
        dimension: "minecraft:overworld", deferred: true,
        blocks: commands.map((command, z) => ({
          pos: [origin[0] + x, origin[1], origin[2] + z + 1], facing: "south", conditional: z > 0, auto: true, command: ir(command),
        })),
        nativeCommands: [[java, `tag @e[tag=${tag},c=1] add marked_${label}`]],
      };
      blocks.push({pos: [x, 0, 0], name: "minecraft:unpowered_comparator", states: compareStates});
      blocks.push(commandBlock({pos: [x, 0, 1], kind: "impulse", facing: 3, alwaysActive: true,
        command: `je2be:run "${id}" ~ ~ ~ ^ ^ ^1 minecraft:overworld`}));
      // The converter empties and disables the physical chain blocks of a runtime chain.
      for (const z of [2, 3]) blocks.push(commandBlock({pos: [x, 0, z], kind: "chain", command: "", facing: 3, conditional: true}));
    }
    writeInitPack(dir, [{objective: "points", scores: []}], [], "", "[]", [], chains);
    const pack = join(dir, "behavior_packs", "je2be_init");
    const structures = join(pack, "structures", "je2be");
    mkdirSync(structures, {recursive: true});
    writeFileSync(join(structures, "deferred.mcstructure"), buildMcstructure({size: [3, 1, 4], blocks, fillAir: true}));

    const bds = await BedrockServer.start({behaviorPacks: [pack]});
    try {
      await bds.waitForLog(line => line.includes("[je2be] initialized"), 30_000, "runtime initialization");
      const run = async (command: string) => {
        expect((await bds.exec(command)).result?.successCount, command).toBe(1);
      };
      await run("summon armor_stand 5.5 -60 5.5");
      await run("tag @e[type=armor_stand,c=1] add deferred_target");
      await run(`fill ${origin[0]} ${origin[1] - 1} ${origin[2]} ${origin[0] + 2} ${origin[1] - 1} ${origin[2] + 3} stone`);
      await run(`structure load je2be:deferred ${origin.join(" ")}`);

      const scores = async () => {
        const {result} = await bds.request<{objective: string; scores: {participant: string; score: number}[]}[]>("scores");
        return Object.fromEntries(result?.find(entry => entry.objective === "points")?.scores.map(
          ({participant, score}) => [participant, score],
        ) ?? []);
      };
      // The missing target makes BE report successCount 0, so after_missing stays unset.
      await expect.poll(scores, {timeout: 10_000}).toEqual({head_found: 1, after_found: 1, head_missing: 1});
      expect((await bds.exec("tag @e[tag=marked_found] add checked")).result?.successCount).toBe(1);
      expect((await bds.exec("tag @e[tag=marked_missing] add checked")).result?.successCount).toBe(0);
      // The launcher returns before the chain runs, so the head's comparator never sees its outcome (#236).
      const comparators = async () => {
        const {result} = await bds.request<{type: string; states: Record<string, unknown>}[]>("blocks",
          {from: [...origin], to: [origin[0] + 2, origin[1], origin[2]]});
        return result?.filter(block => block.type.includes("comparator")).map(block => block.states.output_lit_bit);
      };
      expect(await comparators()).toEqual([false, false]);
      expect(bds.log.some(line => line.includes("tick stopped"))).toBe(false);
    } finally {
      await bds.stop();
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
