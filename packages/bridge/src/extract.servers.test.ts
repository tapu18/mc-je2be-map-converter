// 抽出（#12、@je2be/converter の extractWorld）を、Java版サーバーで作った内容のわかっているワールドで確かめる。
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractWorld, type Extracted } from "@je2be/converter";
import { JavaServer, paths } from "./index.ts";
import { blockDefaults } from "./java-dump.ts";

describe("extract", () => {
  let x: Extracted;
  let java: JavaServer;

  beforeAll(async () => {
    java = await JavaServer.start();
    const set = async (pos: string, block: string, nbt: string): Promise<void> => {
      expect(await java.exec(`setblock ${pos} ${block}${nbt}`)).toMatch(/Changed/);
    };
    // 先頭インパルス → 南へチェーン2つ（2つ目は条件付き）→ 東へ曲がるチェーン
    await set("1 -50 1", "minecraft:command_block[facing=south]", '{Command:"say head"}');
    await set("1 -50 2", "minecraft:chain_command_block[facing=south]", '{Command:"say two",auto:1b}');
    await set("1 -50 3", "minecraft:chain_command_block[facing=east,conditional=true]", '{Command:"say three",auto:1b}');
    await set("2 -50 3", "minecraft:chain_command_block[facing=east]", '{Command:"say four",auto:1b}');
    // 常時実行のリピート（上向き）、どこにもつながらないチェーン
    await set("5 -50 5", "minecraft:repeating_command_block[facing=up]", '{Command:"say repeat",auto:1b,CustomName:"rep"}');
    await set("9 -50 9", "minecraft:chain_command_block[facing=north]", '{Command:"say orphan"}');
    // 既定の状態（facing=north、conditional=false）のインパルス → 北へチェーン。26.x では状態なしで保存される
    await set("12 -50 12", "minecraft:command_block", '{Command:"say default_head"}');
    await set("12 -50 11", "minecraft:chain_command_block", '{Command:"say default_tail",auto:1b}');
    // 別のチャンク（x=40）とネザー
    await set("40 -50 1", "minecraft:command_block[facing=down]", '{Command:"say far"}');
    await java.exec("execute in minecraft:the_nether run forceload add 0 0");
    await new Promise((r) => setTimeout(r, 1000));
    expect(await java.exec('execute in minecraft:the_nether run setblock 0 64 0 minecraft:command_block{Command:"say nether"}')).toMatch(/Changed/);
    await java.exec("scoreboard objectives add t dummy");
    await java.exec("scoreboard players set #a t 5");
    await java.exec('data modify storage je2be:x v set value {k:1}');
    await java.exec('summon minecraft:armor_stand 3.5 -60 3.5 {Tags:["probe"],NoGravity:1b}');
    await java.exec("save-all flush");
    await java.stop();
    const defaults = blockDefaults();
    if (!defaults) throw new Error("blocks.json がない（npm run setup:servers を実行する）");
    x = extractWorld(join(paths.javaServer, "je2be-test"), { blockDefaults: defaults });
  });

  afterAll(async () => { await java?.stop().catch(() => undefined); });

  it("reads world metadata", () => {
    expect(x.dataVersion).toBe(5023);
    expect(x.dimensions).toEqual(expect.arrayContaining(["minecraft:overworld", "minecraft:the_nether"]));
  });

  it("extracts command blocks with kind, facing, conditional, auto, and command", () => {
    const at = (p: string): unknown => x.commandBlocks.find((c) => c.pos.join(" ") === p);
    expect(at("1 -50 1")).toMatchObject({ kind: "impulse", facing: "south", conditional: false, auto: false, command: "say head", dimension: "minecraft:overworld" });
    expect(at("1 -50 3")).toMatchObject({ kind: "chain", facing: "east", conditional: true, auto: true });
    expect(at("5 -50 5")).toMatchObject({ kind: "repeat", facing: "up", auto: true, command: "say repeat" });
    expect((at("5 -50 5") as { customName?: unknown }).customName).toBeDefined();
    expect(x.commandBlocks.find((c) => c.dimension === "minecraft:the_nether")).toMatchObject({ pos: [0, 64, 0], command: "say nether" });
    expect(at("12 -50 12")).toMatchObject({ kind: "impulse", facing: "north", conditional: false });
    expect(x.commandBlocks).toHaveLength(10);
  });

  it("rebuilds chains", () => {
    const shapes = x.chains.map((ch) => ch.map((c) => c.command.replace("say ", "")).join(">")).sort();
    expect(shapes).toEqual(["default_head>default_tail", "far", "head>two>three>four", "nether", "repeat"]);
    expect(x.orphanChainBlocks.map((c) => c.command)).toEqual(["say orphan"]);
  });

  it("extracts scores, storage, and entities", () => {
    expect(x.scores).toEqual([{ objective: "t", scores: [{ participant: "#a", score: 5 }] }]);
    expect(x.storage).toEqual({ "je2be:x": { v: { k: 1 } } });
    expect(x.entities.find((e) => (e.nbt.Tags as string[] | undefined)?.includes("probe"))).toMatchObject({ dimension: "minecraft:overworld", nbt: { id: "minecraft:armor_stand" } });
  });
});
