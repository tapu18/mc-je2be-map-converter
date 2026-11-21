// コマンドの書き換え（#62・#72）を Java の版別文法と Geyser の対応表で確かめる。
// - 入力は Java 26.3 が文法として受理する（checkJavaSyntax）
// - 書き換えの結果は期待した文字列になる
// - 書き換えた BE のコマンドは BDS 1.26.63.1 が構文として受理する（実行の成否は問わない。意味の一致は scenarios/convert/ で確かめる）
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rewriteCommand, type RewriteContext } from "@je2be/core";
import { javaGrammarSources, loadRewriteContext, rewriteWorldCommands, setupJavaGrammar } from "@je2be/converter";
import { BedrockServer, JavaServer, checkJavaSyntax, rewriteResources } from "./index.ts";
import { paths } from "./paths.ts";

/** [Java のコマンド, 期待する BE のコマンド] */
const REWRITTEN: [string, string][] = [
  // セレクタ（F4）
  ["tag @e[type=minecraft:armor_stand,distance=..3,limit=1,sort=nearest] add near", "tag @e[type=armor_stand,r=3,c=1] add near"],
  ["kill @e[tag=a,sort=furthest,limit=2]", "kill @e[tag=a,c=-2]"],
  ["tag @n[type=armor_stand] add n", "tag @e[type=armor_stand,c=1] add n"],
  ["tag @a[level=1..5,gamemode=!creative,x_rotation=-90..0,y_rotation=0..180] add rot", "tag @a[lm=1,l=5,m=!creative,rxm=-90,rx=0,rym=0,ry=180] add rot"],
  ["execute as @a[distance=2..10] at @s run tp @s ~ ~1 ~", "execute as @a[rm=2,r=10] at @s run tp @s ~ ~1 ~"],
  ["say hello @a[distance=..5]", "say hello @a[r=5]"],
  ["tag @e[type=minecraft:zombified_piglin] add z", "tag @e[type=zombie_pigman] add z"],
  ["tag @e[type=!minecraft:evoker] add other", "tag @e[type=!evocation_illager] add other"],
  ["say hi @e[type=minecraft:experience_orb]", "say hi @e[type=xp_orb]"],
  ['tellraw @a {selector:"@e[type=minecraft:tropical_fish]"}', 'tellraw @a {"rawtext":[{"selector":"@e[type=tropicalfish]"}]}'],
  // サウンド・パーティクル・効果
  ["playsound minecraft:entity.experience_orb.pickup master @a[distance=..10]", "playsound random.orb @a[r=10] ~ ~ ~"],
  ["execute as @a run playsound entity.experience_orb.pickup player @s ~ ~ ~ 1 0.5 0", "execute as @a run playsound random.orb @s ~ ~ ~ 1 0.5 0"],
  ["playsound entity.experience_orb.pickup", "playsound random.orb @s ~ ~ ~"],
  ["particle minecraft:flame", "particle minecraft:basic_flame_particle ~ ~ ~"],
  ["particle minecraft:flame ~ ~ ~ 0 0 0 0 1 normal", "particle minecraft:basic_flame_particle ~ ~ ~"],
  ["effect give @a minecraft:speed 3 2 true", "effect @a speed 3 2 true"],
  ["effect give @e[type=minecraft:pig] minecraft:hero_of_the_village infinite", "effect @e[type=pig] village_hero infinite"],
  ["execute as @a run effect clear", "execute as @a run effect @s clear"],
  ["effect clear @e[type=minecraft:pig]", "effect @e[type=pig] clear"],
  ["effect clear @e[type=minecraft:pig] minecraft:hero_of_the_village", "effect @e[type=pig] clear village_hero"],
  // execute とブロック
  [
    "execute positioned 1 -60 3 if block ~ ~ ~ minecraft:oak_stairs[facing=east,half=top] run setblock ~ ~1 ~ minecraft:oak_stairs[facing=west]",
    'execute positioned 1 -60 3 if block ~ ~ ~ minecraft:oak_stairs ["upside_down_bit"=true,"weirdo_direction"=0] run setblock ~ ~1 ~ minecraft:oak_stairs ["minecraft:corner"="none","upside_down_bit"=false,"weirdo_direction"=1]',
  ],
  ["execute in minecraft:the_nether run say n", "execute in nether run say n"],
  ["setblock 1 -60 1 minecraft:oak_log[axis=x] keep", 'setblock 1 -60 1 minecraft:oak_log ["pillar_axis"="x"] keep'],
  ["clone 0 -61 0 1 -61 1 5 -61 5 filtered minecraft:grass_block", "clone 0 -61 0 1 -61 1 5 -61 5 filtered normal minecraft:grass_block"],
  ["clone 0 -61 0 1 -61 1 5 -61 5 filtered minecraft:oak_stairs[facing=east] force", 'clone 0 -61 0 1 -61 1 5 -61 5 filtered force minecraft:oak_stairs ["weirdo_direction"=0]'],
  ["tp @s 5 -60 5 facing entity @e[type=minecraft:armor_stand,limit=1,sort=nearest] feet", "tp @s 5 -60 5 facing @e[type=armor_stand,c=1]"],
  ["teleport @s ~ ~ ~ facing entity @p", "teleport @s ~ ~ ~ facing @p"],
  ["time add 2s", "time add 40"],
  ["time set 1d", "time set 24000"],
  ["weather rain 5s", "weather rain 100"],
  ["gamerule keep_inventory true", "gamerule keepInventory true"],
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
  "gamemode creative",
  "gamemode spectator @a",
  "time set minecraft:noon",
  "time query time",
  "time query gametime",
  "weather clear",
  "weather thunder 100",
  "difficulty normal",
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
  "playsound example:unmapped master @a",
  "particle minecraft:flame ~ ~ ~ 1 0 0 0 2 force",
  "particle minecraft:ash ~ ~ ~",
  "effect give @a minecraft:glowing",
  "kill @e[type=minecraft:oak_boat]",
  "tp @s ~ ~ ~ facing entity @p eyes",
  "clone 0 -61 0 1 -61 1 5 -61 5 filtered #minecraft:logs",
  "difficulty",
  "time pause",
  "function ns:f",
  "kill @e[type=minecraft:marker]",
  "tag @e[nbt={OnGround:1b}] add g",
  'tellraw @a {"nbt":"x","storage":"ns:s"}',
  "execute if block 0 -61 0 minecraft:oak_stairs[waterlogged=true] run say w",
];

const registries = JSON.parse(readFileSync(join(dirname(paths.blocksReport), "registries.json"), "utf8")) as Record<string, { entries: Record<string, unknown> }>;
const types = Object.keys(registries["minecraft:entity_type"]!.entries);
const effects = Object.keys(registries["minecraft:mob_effect"]!.entries);
const selectorProbe = (id: string): string => `execute if entity @e[type=${id}]`;
const effectProbe = (id: string): string => `effect give @e[type=pig] ${id} 20`;

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
    const results = await checkJavaSyntax([
      ...inputs, ...types.map(selectorProbe), ...effects.map(effectProbe), "scoreboard objectives setdisplay belowName t",
    ]);
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

  it("checks vanilla entity and effect IDs against BDS", async () => {
    for (const id of types) {
      const output = rewriteCommand(selectorProbe(id), ctx);
      if ("command" in output) {
        expect(await bds.exec(output.command), output.command).toMatchObject({ ok: true });
      } else {
        expect(output.status, id).toBe("unsupported");
        expect(await bds.exec(selectorProbe(id.slice("minecraft:".length))), id).toMatchObject({ ok: false });
      }
    }

    expect(await bds.exec("summon pig 20 -60 20")).toMatchObject({ ok: true, result: { successCount: 1 } });
    const unsupportedEffects: string[] = [];
    for (const id of effects) {
      const output = rewriteCommand(effectProbe(id), ctx);
      if ("command" in output) {
        expect(await bds.exec(output.command), output.command).toMatchObject({ ok: true, result: { successCount: 1 } });
      } else {
        unsupportedEffects.push(id);
        expect(await bds.exec(`effect @e[type=pig] ${id.slice("minecraft:".length)} 20`), id).toMatchObject({ ok: false });
      }
    }
    expect(unsupportedEffects).toEqual(["minecraft:dolphins_grace", "minecraft:glowing", "minecraft:luck", "minecraft:unluck"]);
    expect(await bds.exec("effect @e[type=pig] clear village_hero")).toMatchObject({ ok: true, result: { successCount: 1 } });
    expect(await bds.exec("effect @e[type=pig] clear village_hero")).toMatchObject({ ok: true, result: { successCount: 0 } });
    expect(await bds.exec("effect @e[type=pig] clear")).toMatchObject({ ok: true, result: { successCount: 1 } });
  });

  it("rewrites command blocks saved by Java 1.20.5 with that world's grammar", async () => {
    const grammar = await setupJavaGrammar(javaGrammarSources().find((source) => source.version === "1.20.5")!);
    const java = await JavaServer.start({ runtime: grammar });
    const commands = [
      ["time set noon", "time set 6000"],
      ["gamerule keepInventory true", "gamerule keepInventory true"],
      [String.raw`tellraw @a {"text":"a\/b"}`, 'tellraw @a {"rawtext":[{"text":"a/b"}]}'],
      ["scoreboard objectives setdisplay belowName", "scoreboard objectives setdisplay belowname"],
      ["execute if entity @e[type=minecraft:boat]", "execute if entity @e[type=boat]"],
    ] as const;
    try {
      expect(await java.exec(commands[0][0])).toContain("6000");
      expect(await java.exec(commands[1][0])).toContain("true");
      for (const [i, [command]] of commands.entries()) {
        expect(await java.exec(`setblock ${i + 1} -58 2 command_block{Command:${JSON.stringify(command)}}`)).toContain("Changed the block");
      }
      expect(await java.exec("save-all flush")).toContain("Saved the game");
    } finally {
      await java.stop();
    }
    const report = rewriteWorldCommands(java.worldDirectory, await rewriteResources());
    expect(report).toMatchObject({ textFormat: "json", counts: { invalid: 0, unsupported: 0, unchanged: 1, rewritten: 4 } });
    expect(report.commandBlocks.map((entry) => [entry.java, entry.bedrock]).sort()).toEqual(commands.filter(([input, output]) => input !== output).sort());
    for (const [, command] of commands) expect(await bds.exec(command), command).toMatchObject({ ok: true });
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
