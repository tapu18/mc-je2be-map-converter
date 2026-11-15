// ブリッジ自体の動作確認。両サーバーで同じ操作をし、結果を取り出せることを確かめる。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BedrockServer, JavaServer } from "./index.ts";

describe("java bridge", () => {
  let java: JavaServer;
  beforeAll(async () => { java = await JavaServer.start(); });
  afterAll(async () => { await java?.stop(); });

  it("runs commands and reads scores", async () => {
    await java.exec("scoreboard objectives add t dummy");
    await java.exec("scoreboard players set #a t 41");
    await java.exec("scoreboard players add #a t 1");
    expect(await java.exec("scoreboard players get #a t")).toMatch(/#a has 42 \[t\]/);
  });

  it("reads block states and storage", async () => {
    await java.exec("setblock 0 -50 0 minecraft:oak_stairs[facing=east,half=top]");
    expect(await java.exec("execute if block 0 -50 0 minecraft:oak_stairs[facing=east]")).toMatch(/Test passed/);
    expect(await java.exec("execute if block 0 -50 0 minecraft:oak_stairs[facing=west]")).toMatch(/Test failed/);
    await java.exec('data modify storage je2be:t v set value {a:[1,2,3]}');
    expect(await java.exec("data get storage je2be:t v")).toMatch(/\{a: \[1, 2, 3\]\}/);
  });
});

describe("bedrock bridge", () => {
  let bds: BedrockServer;
  beforeAll(async () => { bds = await BedrockServer.start(); });
  afterAll(async () => { await bds?.stop(); });

  it("pings", async () => {
    const res = await bds.request<{ tick: number }>("ping");
    expect(res.ok).toBe(true);
    expect(typeof res.result?.tick).toBe("number");
  });

  it("runs commands and reads scores", async () => {
    expect((await bds.exec("scoreboard objectives add t dummy")).ok).toBe(true);
    await bds.exec("scoreboard players set a t 41");
    await bds.exec("scoreboard players add a t 1");
    const res = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
    expect(res.result?.find((o) => o.objective === "t")?.scores).toEqual([
      expect.objectContaining({ participant: "a", score: 42 }),
    ]);
  });

  // runCommand は構文エラーで例外、実行時の失敗では successCount 0 を返す（理由の文字列は取れない）
  it("distinguishes syntax errors from runtime failures", async () => {
    const syntax = await bds.exec("this_is_not_a_command");
    expect(syntax.ok).toBe(false);
    expect(syntax.error).toMatch(/Syntax error/);
    const runtime = await bds.exec("scoreboard players add nobody missing_objective 1");
    expect(runtime).toMatchObject({ ok: true, result: { successCount: 0 } });
  });

  // BE 1.26.63 の階段は weirdo_direction（0〜3）と minecraft:corner を持つ
  it("reads block states", async () => {
    const set = await bds.exec('setblock 1 10 1 oak_stairs ["weirdo_direction"=2,"upside_down_bit"=true]');
    expect(set.result?.successCount).toBe(1);
    const res = await bds.request<{ type: string; states: Record<string, unknown> }[]>("blocks", { from: [1, 10, 1] });
    expect(res.result?.[0]).toMatchObject({
      type: "minecraft:oak_stairs",
      states: { weirdo_direction: 2, upside_down_bit: true, "minecraft:corner": "none" },
    });
  });

  it("generates a flat world", async () => {
    const res = await bds.request<{ type: string }[]>("blocks", { from: [0, -64, 0], to: [0, -60, 0] });
    expect(res.result?.map((b) => b.type)).toEqual([
      "minecraft:bedrock", "minecraft:dirt", "minecraft:dirt", "minecraft:grass_block", "minecraft:air",
    ]);
  });

  it("handles large responses", async () => {
    const res = await bds.request<unknown[]>("blocks", { from: [0, 0, 0], to: [9, 9, 9] });
    expect(res.result).toHaveLength(1000);
  });
});

describe("restart keeps the world", () => {
  it("bedrock", async () => {
    let bds = await BedrockServer.start();
    try {
      await bds.exec("scoreboard objectives add r dummy");
      await bds.exec("scoreboard players set a r 7");
      await bds.exec("setblock 3 -50 3 gold_block");
      bds = await bds.restart();
      const scores = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
      expect(scores.result?.find((o) => o.objective === "r")?.scores).toEqual([expect.objectContaining({ participant: "a", score: 7 })]);
      const blocks = await bds.request<{ type: string }[]>("blocks", { from: [3, -50, 3] });
      expect(blocks.result?.[0]?.type).toBe("minecraft:gold_block");
    } finally {
      await bds.stop();
    }
  });

  it("java", async () => {
    let java = await JavaServer.start();
    try {
      await java.exec("scoreboard objectives add r dummy");
      await java.exec("scoreboard players set #a r 7");
      await java.exec("setblock 3 -50 3 minecraft:gold_block");
      java = await java.restart();
      expect(await java.exec("scoreboard players get #a r")).toMatch(/#a has 7 \[r\]/);
      expect(await java.exec("execute if block 3 -50 3 minecraft:gold_block")).toMatch(/Test passed/);
    } finally {
      await java.stop();
    }
  });
});
