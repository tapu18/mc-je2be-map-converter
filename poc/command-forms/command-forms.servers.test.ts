// #359: random・team・bossbar・damage・rotate・forceload・recipe・ride・spectate の BE での受け皿を BDS で試す。
// 結果は poc/command-forms/results.json に書き出す（台帳の上書きの根拠としてコミットする）。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { BedrockServer } from "@je2be/bridge";
import { withSimulatedPlayer } from "../../packages/bridge/src/simulated-player.ts";

const here = dirname(fileURLToPath(import.meta.url));
const P = "Probe";
const results: Record<string, unknown> = {};

type Entity = { type: string; pos: number[]; rot: number[]; tags: string[]; health?: number; components?: string[] };

describe("BE counterparts of nine Java commands (#359)", () => {
  afterAll(() => { writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2) + "\n"); });

  it("probes commands, scoreboard random, damage, rotation, ticking areas, recipes, riding and camera", async () => {
    await withSimulatedPlayer(P, async (bds: BedrockServer) => {
      const run = async (cmd: string) => {
        const r = await bds.exec(cmd);
        return r.ok ? { ok: true, successCount: r.result!.successCount } : { ok: false, error: r.error };
      };
      const record = async (group: string, cmds: string[]) => {
        const out: Record<string, unknown> = {};
        for (const c of cmds) out[c] = await run(c);
        results[group] = out;
        return out as Record<string, { ok: boolean; successCount?: number; error?: string }>;
      };
      const entities = async (tag: string): Promise<Entity[]> => {
        const r = await bds.request<Entity[]>("entities", { query: { tags: [tag] }, components: true });
        return r.result ?? [];
      };

      // 1. Java の命令名が BE にあるか
      await record("javaHeads", [
        "random value 1..6", "team add je2be", "bossbar add je2be:a \"x\"", "rotate @s 90 0",
        "forceload add 0 0", "spectate", `spectate @e[type=pig,c=1] ${P}`,
      ]);

      // 2. random value → scoreboard players random
      await run("scoreboard objectives add rnd dummy");
      const values: number[] = [];
      const rnd: unknown[] = [];
      for (let i = 0; i < 30; i++) {
        rnd.push(await run(`scoreboard players random v${i} rnd 1 6`));
        const s = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
        values.push(s.result!.find(o => o.objective === "rnd")!.scores.find(x => x.participant === `v${i}`)!.score);
      }
      results.scoreboardRandom = { results: rnd, values, min: Math.min(...values), max: Math.max(...values) };
      results.scoreboardRandomEdge = await record("scoreboardRandomEdge", [
        "scoreboard players random e rnd 5 5", "scoreboard players random e rnd 6 1",
        "scoreboard players random e rnd -2147483648 2147483647",
      ]);

      // 3. damage
      await run("summon pig 4 -60 4");
      await run("tag @e[type=pig] add je2be_p");
      await run("summon cow 6 -60 4");
      await run("tag @e[type=cow] add je2be_c");
      const h0 = (await entities("je2be_p"))[0]?.health;
      const dmg = await record("damage", [
        "damage @e[tag=je2be_p] 1",
        "damage @e[tag=je2be_p] 1 entity_attack entity @e[tag=je2be_c,c=1]",
        "damage @e[tag=je2be_p] 1 fire",
        "damage @e[tag=je2be_p] 1 in_fire",
        "damage @e[tag=je2be_p] 1 minecraft:generic",
        "damage @e[tag=je2be_p] 0.5",
        "damage @e[tag=je2be_p] 1 fire at 0 0 0",
        "damage @e[tag=je2be_nobody] 1",
      ]);
      results.damageHealth = { before: h0, after: (await entities("je2be_p"))[0]?.health, outcomes: dmg };

      // 4. rotate → tp の回転（コンソールの実行位置は 0 0 0 なので、~ は execute at @s の下で使う）
      const rot: Record<string, unknown> = {};
      for (const type of ["armor_stand", "zombie"]) {
        const tag = `je2be_r_${type}`;
        await run(`summon ${type} 10.5 -60 ${type === "zombie" ? 14.5 : 10.5}`);
        await run(`tag @e[type=${type}] add ${tag}`);
        const out: Record<string, unknown> = {};
        for (const c of [
          `tp @e[tag=${tag}] 10.5 -60 ${type === "zombie" ? 14.5 : 10.5} 90 30`,
          `execute as @e[tag=${tag}] at @s run tp @s ~ ~ ~ -90 0`,
          `execute as @e[tag=${tag}] at @s run tp @s ~ ~ ~ ~180 ~`,
          `execute as @e[tag=${tag}] at @s run tp @s ~ ~ ~ facing 20.5 -60 10.5`,
          `execute as @e[tag=${tag}] at @s run tp @s ~ ~ ~ facing @e[tag=je2be_c,c=1]`,
        ]) {
          const result = await run(c);
          const e = (await entities(tag))[0];
          out[c] = { result, pos: e?.pos, rot: e?.rot };
        }
        rot[type] = out;
      }
      results.rotation = rot;

      // 5. forceload → tickingarea
      const ta = await record("tickingarea", [
        "tickingarea add 128 0 128 143 0 143 je2be_fl1",
        "tickingarea add circle 200 0 200 2 je2be_fl2",
        "tickingarea add 300 0 300 300 0 300",
        "tickingarea remove 135 0 135",
        "tickingarea remove je2be_fl2",
        "tickingarea remove 1000 0 1000",
        "tickingarea add 0 0 1000 159 0 1143 je2be_90chunks",
        "tickingarea remove je2be_90chunks",
        "tickingarea add 0 0 1000 159 0 1159 je2be_100chunks",
        "tickingarea remove je2be_100chunks",
        "tickingarea add 0 0 2000 159 0 2175 je2be_110chunks",
        "tickingarea add 0 0 3000 255 0 3255 je2be_256chunks",
        "tickingarea remove_all",
      ]);
      // 既存の領域（検証用の既定領域を含む）を消してから、1チャンクずつ上限まで足す
      await run("tickingarea remove_all");
      const limit: unknown[] = [];
      for (let i = 0; i < 12; i++) limit.push(await run(`tickingarea add ${2000 + i * 32} 0 2000 ${2000 + i * 32} 0 2000 je2be_n${i}`));
      results.tickingareaLimit = limit;
      results.tickingareaRemoveAll = await run("tickingarea remove_all");
      void ta;

      // 6. recipe
      await record("recipe", [
        `recipe take ${P} *`,
        `recipe give ${P} minecraft:crafting_table`,
        `recipe give ${P} minecraft:crafting_table`,
        `recipe take ${P} minecraft:crafting_table`,
        `recipe give ${P} crafting_table`,
        `recipe give ${P} minecraft:stick`,
        `recipe give ${P} minecraft:chest`,
        `recipe give ${P} minecraft:wooden_pickaxe`,
        `recipe give ${P} minecraft:no_such_recipe`,
        `recipe give ${P} *`,
        "recipe give @e[type=pig] minecraft:crafting_table",
      ]);

      // 7. ride
      for (const [type, x] of [["minecart", 14.5], ["oak_boat", 18.5], ["villager_v2", 22.5]] as const) {
        await run(`summon ${type} ${x} -60 4.5`);
        await run(`tag @e[type=${type}] add je2be_v_${type}`);
      }
      await run("summon armor_stand 26.5 -60 4.5");
      await run("tag @e[type=armor_stand,x=26,y=-61,z=4,dx=1,dy=2,dz=1] add je2be_base");
      await run("summon armor_stand 30.5 -60 4.5");
      await run("tag @e[type=armor_stand,x=30,y=-61,z=4,dx=1,dy=2,dz=1] add je2be_top");
      const riding = async (tag: string) => (await entities(tag))[0]?.components?.includes("minecraft:riding") ?? null;
      const ride: Record<string, unknown> = {};
      for (const [c, rider] of [
        ["ride @e[tag=je2be_p] start_riding @e[tag=je2be_v_minecart,c=1]", "je2be_p"],
        ["ride @e[tag=je2be_p] stop_riding", "je2be_p"],
        ["ride @e[tag=je2be_top] start_riding @e[tag=je2be_v_minecart,c=1]", "je2be_top"],
        ["ride @e[tag=je2be_top] stop_riding", "je2be_top"],
        ["ride @e[tag=je2be_p] start_riding @e[tag=je2be_c,c=1]", "je2be_p"],
        ["ride @e[tag=je2be_top] start_riding @e[tag=je2be_v_villager_v2,c=1]", "je2be_top"],
        ["ride @e[tag=je2be_top] start_riding @e[tag=je2be_base,c=1]", "je2be_top"],
        [`ride ${P} start_riding @e[tag=je2be_v_oak_boat,c=1]`, null],
        [`ride ${P} stop_riding`, null],
      ] as const) {
        ride[c] = { result: await run(c), riderHasRidingComponent: rider ? await riding(rider) : undefined };
      }
      results.ride = ride;

      // 8. spectate → camera
      await record("camera", [
        `camera ${P} set minecraft:free pos 10 -55 10 facing @e[tag=je2be_c,c=1]`,
        `camera ${P} clear`,
        `gamemode spectator ${P}`,
      ]);
    });

    // ---- 実測で確かめた事実 ----
    const r = results as any;
    const ok = (n: number) => ({ ok: true, successCount: n });
    // Java の 6 命令名は BE の構文にない
    for (const [cmd, res] of Object.entries(r.javaHeads)) expect((res as any).error, cmd).toMatch(/Syntax error: Unexpected/);
    // scoreboard players random は両端を含む。最小 = 最大と最小 > 最大は成功件数 0
    expect(r.scoreboardRandom.results).toEqual(Array(30).fill(ok(1)));
    expect(r.scoreboardRandom.min).toBeGreaterThanOrEqual(1);
    expect(r.scoreboardRandom.max).toBeLessThanOrEqual(6);
    expect(Object.values(r.scoreboardRandomEdge)).toEqual([ok(0), ok(0), ok(1)]);
    // damage は整数だけ。BE の原因名は受け付け、Java の名前空間付き・Java 専用の型は構文エラー
    expect(r.damage["damage @e[tag=je2be_p] 1"]).toEqual(ok(1));
    expect(r.damage["damage @e[tag=je2be_p] 1 entity_attack entity @e[tag=je2be_c,c=1]"]).toEqual(ok(1));
    expect(r.damage["damage @e[tag=je2be_p] 1 fire"]).toEqual(ok(1));
    for (const c of ["damage @e[tag=je2be_p] 1 in_fire", "damage @e[tag=je2be_p] 1 minecraft:generic", "damage @e[tag=je2be_p] 0.5", "damage @e[tag=je2be_p] 1 fire at 0 0 0"]) {
      expect(r.damage[c].error, c).toMatch(/Syntax error/);
    }
    expect(r.damage["damage @e[tag=je2be_nobody] 1"]).toEqual(ok(0));
    expect(r.damageHealth.before).toBeGreaterThan(r.damageHealth.after);
    // tp の回転で yaw を絶対・相対・facing で設定でき、位置は変わらない（防具立て）
    const stand = r.rotation.armor_stand;
    for (const v of Object.values(stand)) {
      expect((v as any).result).toEqual(ok(1));
      expect((v as any).pos).toEqual([10.5, -60, 10.5]);
    }
    expect(stand["execute as @e[tag=je2be_r_armor_stand] at @s run tp @s ~ ~ ~ -90 0"].rot[1]).toBe(-90);
    expect(stand["execute as @e[tag=je2be_r_armor_stand] at @s run tp @s ~ ~ ~ ~180 ~"].rot[1]).toBe(90);
    expect(stand["execute as @e[tag=je2be_r_armor_stand] at @s run tp @s ~ ~ ~ facing 20.5 -60 10.5"].rot[1]).toBe(-90);
    // tickingarea：1 領域 90 チャンクは可、100 チャンクは不可。数は 10 まで。位置指定の remove は含む領域を消す
    expect(r.tickingarea["tickingarea add 0 0 1000 159 0 1143 je2be_90chunks"]).toEqual(ok(1));
    expect(r.tickingarea["tickingarea add 0 0 1000 159 0 1159 je2be_100chunks"]).toEqual(ok(0));
    expect(r.tickingarea["tickingarea remove 135 0 135"]).toEqual(ok(1));
    expect(r.tickingarea["tickingarea remove 1000 0 1000"]).toEqual(ok(0));
    expect(r.tickingareaLimit).toEqual([...Array(10).fill(ok(1)), ok(0), ok(0)]);
    // recipe はプレイヤーだけ。存在しない ID は成功件数 0 で、エラーにならない
    expect(r.recipe[`recipe give ${P} minecraft:stick`]).toEqual(ok(1));
    expect(r.recipe[`recipe give ${P} minecraft:no_such_recipe`]).toEqual(ok(0));
    expect(r.recipe[`recipe give ${P} *`]).toEqual(ok(1));
    expect(r.recipe["recipe give @e[type=pig] minecraft:crafting_table"].error).toMatch(/player-type/);
    // ride は乗り物の rideable が受け入れるときだけ。牛・村人・防具立ての上には乗れない
    const ride = r.ride;
    expect(ride["ride @e[tag=je2be_p] start_riding @e[tag=je2be_v_minecart,c=1]"]).toEqual({ result: ok(1), riderHasRidingComponent: true });
    expect(ride["ride @e[tag=je2be_p] stop_riding"]).toEqual({ result: ok(1), riderHasRidingComponent: false });
    expect(ride["ride @e[tag=je2be_top] start_riding @e[tag=je2be_v_minecart,c=1]"]).toEqual({ result: ok(1), riderHasRidingComponent: true });
    for (const c of ["ride @e[tag=je2be_p] start_riding @e[tag=je2be_c,c=1]", "ride @e[tag=je2be_top] start_riding @e[tag=je2be_v_villager_v2,c=1]", "ride @e[tag=je2be_top] start_riding @e[tag=je2be_base,c=1]"]) {
      // 豚は近くのトロッコに自分から乗り直すことがあるため、成功件数だけを見る
      expect(ride[c].result, c).toEqual(ok(0));
    }
    // camera はプレイヤーに固定視点を設定・解除できる
    expect(Object.values(r.camera)).toEqual([ok(1), ok(1), ok(1)]);
  });
});
