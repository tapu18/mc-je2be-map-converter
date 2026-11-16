// コマンドの書き換え（#62）を、本物の文法（Java 26.3 の commands.json）と Geyser の対応表で確かめる。
// - 入力は Java 26.3 が文法として受理する（checkJavaSyntax）
// - 書き換えの結果は期待した文字列になる
// - 書き換えた BE のコマンドは BDS 1.26.63.1 が構文として受理する（実行の成否は問わない。意味の一致は scenarios/convert/ で確かめる）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rewriteCommand, type RewriteContext } from "@je2be/core";
import { loadRewriteContext } from "@je2be/converter";
import { BedrockServer, checkJavaSyntax, rewriteResources } from "./index.ts";

/** [Java のコマンド, 期待する BE のコマンド] */
const REWRITTEN: [string, string][] = [
  // セレクタ（F4）
  ["tag @e[type=minecraft:armor_stand,distance=..3,limit=1,sort=nearest] add near", "tag @e[type=armor_stand,r=3,c=1] add near"],
  ["kill @e[tag=a,sort=furthest,limit=2]", "kill @e[tag=a,c=-2]"],
  ["tag @n[type=armor_stand] add n", "tag @e[type=armor_stand,c=1] add n"],
  ["tag @a[level=1..5,gamemode=!creative,x_rotation=-90..0,y_rotation=0..180] add rot", "tag @a[lm=1,l=5,m=!creative,rxm=-90,rx=0,rym=0,ry=180] add rot"],
  ["execute as @a[distance=2..10] at @s run tp @s ~ ~1 ~", "execute as @a[rm=2,r=10] at @s run tp @s ~ ~1 ~"],
  ["say hello @a[distance=..5]", "say hello @a[r=5]"],
  // execute とブロック
  [
    "execute positioned 1 -60 3 if block ~ ~ ~ minecraft:oak_stairs[facing=east,half=top] run setblock ~ ~1 ~ minecraft:oak_stairs[facing=west]",
    'execute positioned 1 -60 3 if block ~ ~ ~ minecraft:oak_stairs ["upside_down_bit"=true,"weirdo_direction"=0] run setblock ~ ~1 ~ minecraft:oak_stairs ["minecraft:corner"="none","upside_down_bit"=false,"weirdo_direction"=1]',
  ],
  ["execute in minecraft:the_nether run say n", "execute in nether run say n"],
  ["setblock 1 -60 1 minecraft:oak_log[axis=x] keep", 'setblock 1 -60 1 minecraft:oak_log ["pillar_axis"="x"] keep'],
  // テキスト（F5）
  ['tellraw @a [{"text":"Score: ","color":"gold"},{"score":{"name":"@p","objective":"t"}}]', 'tellraw @a {"rawtext":[{"text":"§6Score: "},{"score":{"name":"@p","objective":"t"}}]}'],
  ['tellraw @a {text:"hi",color:"red",extra:[{selector:"@e[type=minecraft:pig,limit=1,sort=nearest]"}]}', 'tellraw @a {"rawtext":[{"text":"§chi"},{"selector":"@e[type=pig,c=1]"}]}'],
  ['title @a title {"text":"Stage 1","bold":true}', 'titleraw @a title {"rawtext":[{"text":"§lStage 1"}]}'],
  ['title @a actionbar "x"', 'titleraw @a actionbar {"rawtext":[{"text":"x"}]}'],
  ["title @a times 1s 2s 10", "title @a times 20 40 10"],
  ['scoreboard objectives add disp dummy {"text":"Shown"}', 'scoreboard objectives add disp dummy "Shown"'],
  ["scoreboard objectives setdisplay below_name t", "scoreboard objectives setdisplay belowname t"],
  // 偽プレイヤーの名前（BE は引用符が要る）
  ["execute if score #a t matches 1.. run say yes", 'execute if score "#a" t matches 1.. run say yes'],
  ["execute if score #a t < $b t run scoreboard players set $c t 1", 'execute if score "#a" t < "$b" t run scoreboard players set "$c" t 1'],
  ["scoreboard players operation #a t += #b t", 'scoreboard players operation "#a" t += "#b" t'],
];

/** 書き換えずにそのまま BE で受理されるもの */
const UNCHANGED = [
  "tag @a[dx=4,dy=2,dz=4,x=0,y=-60,z=0,scores={t=1..}] add box",
  "scoreboard players add fake.name t 1",
  "execute unless block 0 -61 0 minecraft:oak_stairs run say no",
  "fill 0 -60 0 3 -60 3 minecraft:white_wool replace minecraft:air",
  "execute unless entity @e[tag=x] run scoreboard players add kept t 1",
  "setblock 1 -60 1 minecraft:stone_bricks",
  "fill 0 -60 0 3 -60 3 minecraft:red_concrete hollow",
  "clone 0 -61 0 1 -61 1 5 -61 5 masked move",
  "give @p minecraft:red_wool 4",
  "scoreboard objectives add t dummy",
  "scoreboard objectives setdisplay sidebar t",
  "scoreboard players reset * t",
];

/** BE のコマンド1個にできないもの（ランタイムで扱う。M2） */
const UNSUPPORTED = [
  "execute store result score #a t run time query gametime",
  "give @p minecraft:diamond_sword[minecraft:damage=5]",
  "scoreboard objectives add deaths deathCount",
  "playsound minecraft:entity.experience_orb.pickup master @a",
  "particle minecraft:flame ~ ~ ~ 0 0 0 0 1",
  "function ns:f",
  "kill @e[type=minecraft:marker]",
  "tag @e[nbt={OnGround:1b}] add g",
  'tellraw @a {"nbt":"x","storage":"ns:s"}',
  "execute if block 0 -61 0 minecraft:oak_stairs[waterlogged=true] run say w",
];

describe("command rewrite against the real grammar and mappings", () => {
  let ctx: RewriteContext;
  let bds: BedrockServer;
  beforeAll(async () => {
    ctx = loadRewriteContext(await rewriteResources(), "snbt");
    bds = await BedrockServer.start();
  });
  afterAll(async () => { await bds?.stop(); });

  it("uses inputs that Java 26.3 accepts", async () => {
    // function ns:f は参照先がないため Java の関数の読み込みでは拒否される（文法でなく参照の検証、docs/findings.md）
    const inputs = [...REWRITTEN.map(([j]) => j), ...UNCHANGED, ...UNSUPPORTED.filter((c) => c !== "function ns:f")];
    const results = await checkJavaSyntax([...inputs, "scoreboard objectives setdisplay belowName t"]);
    expect(results.filter((r) => !r.ok).map((r) => r.command)).toEqual([
      // 26.3 の表示場所の名前は below_name。旧名は拒否される
      "scoreboard objectives setdisplay belowName t",
    ]);
  });

  it("rewrites to the expected BE commands and reports what has no BE form", () => {
    for (const [java, be] of REWRITTEN) expect(rewriteCommand(java, ctx), java).toMatchObject({ status: "rewritten", command: be });
    for (const c of UNCHANGED) expect(rewriteCommand(c, ctx), c).toMatchObject({ status: "unchanged", command: c });
    for (const c of UNSUPPORTED) expect(rewriteCommand(c, ctx), c).toMatchObject({ status: "unsupported" });
  });

  it("produces commands that BDS accepts", async () => {
    await bds.exec("scoreboard objectives add t dummy");
    const rejected: { command: string; error: unknown }[] = [];
    for (const c of [...REWRITTEN.map(([, b]) => b), ...UNCHANGED]) {
      const res = await bds.exec(c);
      if (!res.ok) rejected.push({ command: c, error: res.error });
    }
    expect(rejected).toEqual([]);
  });

  it("needs quotes for fake player names and matches block predicates on the listed states only", async () => {
    await bds.exec("scoreboard objectives add q dummy");
    // 引用符なしの #a は scoreboard players では読めるが、execute if score では読めない。$b はどちらでも読めない
    expect(await bds.exec("scoreboard players set #a q 1")).toMatchObject({ ok: true, result: { successCount: 1 } });
    expect(await bds.exec("execute if score #a q matches 1 run say x")).toMatchObject({ ok: false });
    expect(await bds.exec("scoreboard players set $b q 1")).toMatchObject({ ok: false });
    expect(await bds.exec('scoreboard players set "$b" q 1')).toMatchObject({ ok: true, result: { successCount: 1 } });
    expect(await bds.exec('execute if score "#a" q = "$b" q run say x')).toMatchObject({ ok: true, result: { successCount: 1 } });
    // 状態の一部だけを書いた条件は、書いた状態だけを比べる
    await bds.exec('setblock 30 -60 30 minecraft:oak_stairs ["weirdo_direction"=1,"upside_down_bit"=true]');
    expect(await bds.exec('execute if block 30 -60 30 minecraft:oak_stairs ["weirdo_direction"=1] run say x')).toMatchObject({ ok: true, result: { successCount: 1 } });
    expect(await bds.exec('execute if block 30 -60 30 minecraft:oak_stairs ["weirdo_direction"=0] run say x')).toMatchObject({ ok: true, result: { successCount: 0 } });
    expect(await bds.exec("execute if block 30 -60 30 minecraft:oak_stairs run say x")).toMatchObject({ ok: true, result: { successCount: 1 } });
  });
});
