import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";
import { CommandParser, serializeCommandIR, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { writeInitPack } from "../../converter/src/convert.ts";

it("restores committed scores and storage before load and runs schedule before tick", async () => {
  const dir = mkdtempSync(join(paths.servers, "runtime-startup-"));
  try {
    const tree = JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode;
    const parser = new CommandParser(tree, {textFormat: "snbt"});
    const scripts = {
      "test:load": [
        "scoreboard players add #loads clock 1",
        "execute store result score #restored clock run data get storage test:clock last",
        "execute store result storage test:clock last int 1 run scoreboard players get #loads clock",
        "scoreboard players set #scheduled clock 0",
        "schedule function test:scheduled 1t",
      ],
      "test:scheduled": ["scoreboard players operation #scheduled clock = #tick clock"],
      "test:tick": [
        "execute if score #scheduled clock = #tick clock run scoreboard players add #ordered clock 1",
        "scoreboard players add #tick clock 1",
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
    writeInitPack(dir, [{objective: "clock", scores: ["#tick", "#loads", "#ordered"].map(participant => ({participant, score: 0}))}],
      [], JSON.stringify(datapacks));

    let bds = await BedrockServer.start({behaviorPacks: [join(dir, "behavior_packs", "je2be_init")], tickingArea: false});
    try {
      const scores = async () => {
        const {result} = await bds.request<{objective: string; scores: {participant: string; score: number}[]}[]>("scores");
        return Object.fromEntries(result?.find(row => row.objective === "clock")?.scores.map(
          ({participant, score}) => [participant, score],
        ) ?? []);
      };
      const clock = async () => (await scores())["#tick"] ?? 0;
      await expect.poll(clock, {timeout: 30_000}).toBeGreaterThan(0);
      const first = await scores();
      expect(first).toMatchObject({"#loads": 1, "#ordered": 1, "#scheduled": 0});

      bds = await bds.restart();
      await expect.poll(clock, {timeout: 30_000}).toBeGreaterThan(first["#tick"]!);
      expect(await scores()).toMatchObject({"#loads": 2, "#restored": 1, "#ordered": 2});
    } finally {
      await bds.stop();
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
