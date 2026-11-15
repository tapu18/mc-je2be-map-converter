// Java版サーバーの状態ダンプ（#7）。内容のわかっている状態を作り、保存データから正しく読めるかを確かめる。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JavaServer } from "./index.ts";

describe("java dump", () => {
  let java: JavaServer;
  beforeAll(async () => {
    java = await JavaServer.start();
    for (const c of [
      "setblock 1 -50 2 minecraft:oak_stairs[facing=east,half=top]",
      "setblock 2 -50 2 minecraft:stone",
      'setblock 3 -50 2 minecraft:command_block[facing=up]{Command:"say hi",auto:0b}',
      // 1つのセクションにパレットが多い場合（詰め方のビット数が増える）
      "fill 0 -45 0 15 -45 15 minecraft:white_wool",
      ...["red", "blue", "green", "yellow", "black", "orange", "lime", "cyan", "purple", "pink", "gray", "brown", "magenta", "light_blue", "light_gray"].map(
        (c, i) => `setblock ${i} -45 ${i} minecraft:${c}_wool`,
      ),
      "scoreboard objectives add t dummy",
      "scoreboard players set #a t 42",
      "scoreboard players set #b t -7",
      'data modify storage je2be:s v set value {a:[1,2,3],b:"x",c:1.5d,l:9000000000L}',
      'summon minecraft:armor_stand 5.5 -60 5.5 {Tags:["probe","two"],NoGravity:1b,Rotation:[90f,10f]}',
    ]) await java.exec(c);
  });
  afterAll(async () => { await java?.stop(); });

  it("reads blocks with states and block entities", async () => {
    const d = await java.dump({ blocks: { from: [1, -50, 2], to: [3, -50, 2] } });
    expect(d.blocks?.map(({ nbt: _nbt, ...b }) => b)).toEqual([
      { pos: [1, -50, 2], type: "minecraft:oak_stairs", states: { facing: "east", half: "top", shape: "straight", waterlogged: "false" } },
      { pos: [2, -50, 2], type: "minecraft:stone", states: {} },
      { pos: [3, -50, 2], type: "minecraft:command_block", states: { conditional: "false", facing: "up" } },
    ]);
    expect(d.blocks?.[2]?.nbt).toMatchObject({ Command: "say hi", auto: 0, id: "minecraft:command_block" });
  });

  it("reads many-entry palettes", async () => {
    const d = await java.dump({ blocks: { from: [0, -45, 0], to: [15, -45, 15] } });
    const at = (x: number, z: number): string | undefined => d.blocks?.find((b) => b.pos[0] === x && b.pos[2] === z)?.type;
    expect(at(0, 0)).toBe("minecraft:red_wool");
    expect(at(14, 14)).toBe("minecraft:light_gray_wool");
    expect(at(14, 0)).toBe("minecraft:white_wool");
    expect(d.blocks).toHaveLength(256);
  });

  it("reads scores, storage, and entities", async () => {
    const d = await java.dump({ scores: true, storage: true, entities: true });
    expect(d.scores).toEqual([{ objective: "t", scores: expect.arrayContaining([{ participant: "#a", score: 42 }, { participant: "#b", score: -7 }]) }]);
    expect(d.storage).toEqual({ "je2be:s": { v: { a: [1, 2, 3], b: "x", c: 1.5, l: "9000000000" } } });
    const stand = d.entities?.find((e) => e.tags.includes("probe"));
    // タグは集合として保存されるため、指定した順にはならない
    expect(stand).toMatchObject({ type: "minecraft:armor_stand", pos: [5.5, -60, 5.5], rot: [10, 90] });
    expect([...stand!.tags].sort()).toEqual(["probe", "two"]);
    expect(stand?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("reflects changes made after the previous dump", async () => {
    await java.exec("setblock 2 -50 2 minecraft:gold_block");
    await java.exec("scoreboard players add #a t 1");
    const d = await java.dump({ blocks: { from: [2, -50, 2] }, scores: true });
    expect(d.blocks?.[0]?.type).toBe("minecraft:gold_block");
    expect(d.scores?.[0]?.scores).toContainEqual({ participant: "#a", score: 43 });
  });
});
