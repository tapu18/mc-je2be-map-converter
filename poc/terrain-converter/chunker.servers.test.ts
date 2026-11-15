// #6: 地形変換器 Chunker が、コマンドブロック・エンティティ・スコア・storage をどこまで運ぶか。
// Java 26.3 でテストワールドを作り、Chunker で BE 1.26.60 形式に変換し、BDS で読み込んで比べる。
// 結果は poc/terrain-converter/results.chunker.json に書き出す（根拠としてコミットする）。
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BedrockServer, JavaServer, paths } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
const servers = JSON.parse(readFileSync(join(here, "../../tools/servers.json"), "utf8")) as { chunker: { version: string } };
const chunkerJar = join(paths.servers, "tools", `chunker-cli-${servers.chunker.version}.jar`);
const Y = -50;

/** Java のテストワールドに置くコマンドブロック。x 列ごとに1ケース。BE でも同じ文法で動くコマンドだけを使う */
const cbCases: { name: string; x: number; blocks: { kind: "repeating" | "chain" | "command"; facing: string; cmd: string; auto?: boolean; conditional?: boolean; name?: string }[] }[] = [
  { name: "repeat", x: 1, blocks: [{ kind: "repeating", facing: "south", cmd: "scoreboard players add r_repeat t 1" }] },
  // 現行構文の execute（BE で旧構文として読まれると動かない）
  { name: "modern_execute", x: 3, blocks: [{ kind: "repeating", facing: "south", cmd: "execute positioned ~ ~ ~ if entity @e[type=armor_stand,tag=probe] run scoreboard players add r_modern t 1" }] },
  {
    name: "chain",
    x: 5,
    blocks: [
      { kind: "repeating", facing: "south", cmd: "scoreboard players add r_chain_head t 1" },
      { kind: "chain", facing: "south", cmd: "scoreboard players add r_chain_tail t 1" },
    ],
  },
  {
    name: "conditional",
    x: 7,
    blocks: [
      { kind: "repeating", facing: "south", cmd: "scoreboard players add nobody missing_objective 1" },
      { kind: "chain", facing: "south", cmd: "scoreboard players add r_cond t 1", conditional: true },
    ],
  },
  { name: "needs_redstone", x: 9, blocks: [{ kind: "repeating", facing: "south", cmd: "scoreboard players add r_redstone t 1", auto: false }] },
  {
    name: "turn_up",
    x: 11,
    blocks: [
      { kind: "repeating", facing: "up", cmd: "scoreboard players add r_up_head t 1" },
      { kind: "chain", facing: "up", cmd: "scoreboard players add r_up_tail t 1" },
    ],
  },
  // エンティティに頼らない現行構文（下の石を条件にする）
  { name: "modern_if_block", x: 15, blocks: [{ kind: "repeating", facing: "south", cmd: "execute if block ~ ~-1 ~ minecraft:stone run scoreboard players add r_modern_block t 1" }] },
  { name: "modern_positioned", x: 17, blocks: [{ kind: "repeating", facing: "south", cmd: "execute positioned ~1 ~ ~ run scoreboard players add r_modern_pos t 1" }] },
  { name: "named", x: 13, blocks: [{ kind: "repeating", facing: "south", cmd: "scoreboard players add r_named t 1", name: "named_cb" }] },
];

const entities = [
  'summon minecraft:armor_stand 20.5 -60 5.5 {Tags:["probe"],NoGravity:1b,CustomName:"stand_name"}',
  'summon minecraft:marker 22.5 -60 5.5 {Tags:["probe_marker"]}',
  'summon minecraft:text_display 24.5 -59 5.5 {Tags:["probe_text"],text:"hello"}',
  'summon minecraft:block_display 26.5 -59 5.5 {Tags:["probe_block"],block_state:{Name:"minecraft:stone"}}',
  'summon minecraft:item_display 28.5 -59 5.5 {Tags:["probe_item"],item:{id:"minecraft:diamond",count:1}}',
  'summon minecraft:interaction 30.5 -60 5.5 {Tags:["probe_interaction"],width:1f,height:1f}',
  'summon minecraft:pig 32.5 -60 5.5 {Tags:["probe_pig"],NoAI:1b,CustomName:"piggy"}',
];

const results: Record<string, unknown> = { chunker: servers.chunker.version };
const work = mkdtempSync(join(tmpdir(), "je2be-chunker-"));

afterAll(() => {
  writeFileSync(join(here, "results.chunker.json"), JSON.stringify(results, null, 2) + "\n");
  rmSync(work, { recursive: true, force: true });
});

describe("chunker", () => {
  it("converts a Java 26.3 world and loads it in BDS", async () => {
    // 1. Java のテストワールドを作る
    const java = await JavaServer.start();
    try {
      await java.exec(`fill 0 ${Y - 1} 0 40 ${Y - 1} 12 minecraft:stone`);
      for (const c of cbCases) {
        let pos: [number, number, number] = [c.x, Y, 0];
        for (const b of c.blocks) {
          const nbt = `{Command:'${b.cmd}',auto:${b.auto === false ? 0 : 1}b${b.name ? `,CustomName:"${b.name}"` : ""}}`;
          const block = `minecraft:${b.kind === "repeating" ? "repeating_command_block" : b.kind === "chain" ? "chain_command_block" : "command_block"}[facing=${b.facing},conditional=${b.conditional ? "true" : "false"}]`;
          expect(await java.exec(`setblock ${pos.join(" ")} ${block}${nbt}`), `${c.name}`).toMatch(/Changed/);
          pos = b.facing === "up" ? [pos[0], pos[1] + 1, pos[2]] : [pos[0], pos[1], pos[2] + 1];
        }
      }
      await java.exec("scoreboard objectives add t dummy");
      await java.exec("scoreboard objectives add java_only dummy");
      await java.exec("scoreboard players set #kept java_only 7");
      await java.exec('data modify storage je2be:s v set value {a:1}');
      for (const e of entities) expect(await java.exec(e), e).toMatch(/Summoned/);
      await new Promise((r) => setTimeout(r, 1000));
      const before = await java.dump({ scores: true, entities: true });
      results.javaScores = before.scores;
      results.javaEntities = before.entities?.map((e) => ({ type: e.type, tags: [...e.tags].sort() }));
    } finally {
      await java.stop();
    }

    // 2. Chunker で変換する
    const input = join(work, "java");
    const output = join(work, "bedrock");
    cpSync(join(paths.javaServer, "je2be-test"), input, { recursive: true });
    const started = Date.now();
    const log = execFileSync(paths.java, ["-jar", chunkerJar, "-i", input, "-f", "BEDROCK_R26_60", "-o", output], { encoding: "utf8", cwd: work, timeout: 300_000 });
    results.conversion = { ms: Date.now() - started, logTail: log.split("\n").filter((l) => l.trim()).slice(-5) };

    // 3. BDS で読み込む（スコアは運ばれない見込みなので、目的変数を作り直してからコマンドブロックの動作を見る）
    const bds = await BedrockServer.start({ world: output });
    try {
      const blocks = await bds.request<{ pos: number[]; type: string; states: Record<string, unknown> }[]>("blocks", { from: [0, Y, 0], to: [14, Y + 1, 1] });
      results.bedrockBlocks = blocks.result?.filter((b) => b.type?.includes("command_block"));
      const scoresAtLoad = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
      results.bedrockScoresAtLoad = scoresAtLoad.result;
      const ents = await bds.request<{ type: string; tags: string[]; nameTag: string; pos: number[] }[]>("entities", {});
      results.bedrockEntitiesAtLoad = ents.result?.map((e) => ({ type: e.type, tags: [...e.tags].sort(), nameTag: e.nameTag }));

      await bds.exec("scoreboard objectives add t dummy");
      await new Promise((r) => setTimeout(r, 3000));
      const after = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
      // エンティティの読み込みが遅れる可能性があるため、時間を置いてもう一度見る
      const ents2 = await bds.request<{ type: string; tags: string[]; nameTag: string; pos: number[] }[]>("entities", {});
      results.bedrockEntitiesAfter3s = ents2.result?.map((e) => ({ type: e.type, tags: [...e.tags].sort(), nameTag: e.nameTag, pos: e.pos }));
      results.bedrockScoresAfter3s = after.result?.find((o) => o.objective === "t")?.scores.map((s) => ({ participant: s.participant, score: s.score }));
      results.contentLog = bds.log.filter((l) => /ERROR|WARN/.test(l) && !l.includes("JE2BE_"));

      // ---- 実測で確かめた事実（Chunker 1.21.0、Java 26.3 → BE 1.26.60 形式） ----
      // コマンドブロックの種類・向き・条件付きは運ばれる
      const cb = (x: number, y: number, z: number): unknown => (results.bedrockBlocks as { pos: number[]; type: string; states: unknown }[]).find((b) => b.pos.join() === [x, y, z].join());
      expect(cb(5, Y, 1)).toMatchObject({ type: "minecraft:chain_command_block", states: { facing_direction: 3, conditional_bit: false } });
      expect(cb(7, Y, 1)).toMatchObject({ type: "minecraft:chain_command_block", states: { conditional_bit: true } });
      expect(cb(11, Y, 0)).toMatchObject({ type: "minecraft:repeating_command_block", states: { facing_direction: 1 } });
      // 常時実行・チェーン・上向き・名前付き・現行構文の execute は BE でそのまま動く。条件付きは前の失敗で止まり、レッドストーン必要は止まったまま
      const t = Object.fromEntries((results.bedrockScoresAfter3s as { participant: string; score: number }[]).map((x) => [x.participant, x.score]));
      for (const k of ["r_repeat", "r_chain_head", "r_chain_tail", "r_up_head", "r_up_tail", "r_named", "r_modern_block", "r_modern_pos"]) expect(t[k], k).toBeGreaterThan(20);
      expect(t.r_cond).toBeUndefined();
      expect(t.r_redstone).toBeUndefined();
      // エンティティを条件にした execute は、エンティティが運ばれないため動かない
      expect(t.r_modern).toBeUndefined();
      // スコア（と storage）は運ばれない
      expect(results.bedrockScoresAtLoad).toEqual([]);
      // エンティティは1体も運ばれない（防具立て、豚、marker、表示用エンティティ、interaction すべて）
      expect(results.bedrockEntitiesAfter3s).toEqual([]);
      expect(results.contentLog).toEqual([]);
    } finally {
      await bds.stop();
    }
  });
});
