// #357: NBT 付き summon の上位キーを、召喚の直後に Script API で設定して読み戻せるか。
// 結果は poc/summon-nbt/results.json に書き出す（根拠としてコミットする）。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BedrockServer } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, "pack");

type Response = { id: number; ok: boolean; result?: any; error?: string };

describe("summon nbt poc", () => {
  let bds: BedrockServer;
  let nextId = 1;
  const results: Record<string, unknown> = {};

  const call = async (op: string): Promise<Response> => {
    const id = nextId++;
    bds.console(`scriptevent je2be:summon ${JSON.stringify({ id, op })}`);
    const deadline = Date.now() + 60_000;
    for (;;) {
      for (const line of bds.log) {
        const i = line.indexOf("POC_SUMMON {");
        if (i < 0) continue;
        const res = JSON.parse(line.slice(i + 11)) as Response;
        if (res.id === id) return res;
      }
      if (Date.now() > deadline) throw new Error(`timeout: ${op}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    bds = await BedrockServer.start({ behaviorPacks: [packDir] });
    await bds.exec("tickingarea add 0 -64 0 31 -50 15 summon_nbt");
    await bds.request("loaded", { pos: [24, -60, 0] });
  });

  afterAll(async () => {
    writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");
    await bds?.stop();
  });

  it("sets and reads back top keys after spawning", async () => {
    const res = await call("scripted");
    expect(res.ok, res.error).toBe(true);
    results.scripted = res.result;

    // ---- 実測で確かめた事実 ----
    for (const type of ["armor_stand", "zombie"]) {
      const r = res.result[type];
      // spawnEntity の initialRotation は yaw（y）だけを決める
      expect(r.initialRotation, type).toEqual({ x: 0, y: 90 });
      for (const when of ["immediate", "nextTick"] as const) {
        const back = r[when];
        // Tags → addTag、名前（text の候補）→ nameTag（改行を含む）、表示用の値 → 動的プロパティの JSON は、同じ tick でも次の tick でも読み戻せる
        expect(back.tags.value, `${type} ${when}`).toEqual(["je2be_a", "je2be_b", "je2be_c"]);
        expect(back.nameTag.value, `${type} ${when}`).toBe("Hello\nWorld");
        expect(JSON.parse(back.dynamic.value).transformation.scale, `${type} ${when}`).toEqual([2, 2, 2]);
        // 装備は Script API では書けない（equippable はプレイヤーだけ）
        expect(back.mainhand.value, `${type} ${when}`).toBeNull();
      }
      expect(r.setMainhand.value, type).toBe("no equippable");
      // setRotation は同じ tick では yaw・pitch とも読み戻せる
      expect(r.immediate.rotation.value, type).toEqual({ x: 30, y: -45 });
    }
    // 防具立ては次の tick でも pitch を保つ（ゾンビは AI が頭を動かすため期待値にしない）
    expect(res.result.armor_stand.nextTick.rotation.value).toEqual({ x: 30, y: -45 });
  });

  it("writes rotation and name with BE summon arguments", async () => {
    const res = await call("command");
    expect(res.ok, res.error).toBe(true);
    results.command = res.result;

    // ---- 実測で確かめた事実：BE の summon は yaw・pitch と名前を引数で書ける ----
    const c = res.result;
    expect(c.rotation.entities).toEqual([{ type: "minecraft:armor_stand", rotation: { x: 30, y: 90 }, nameTag: "" }]);
    expect(c.zombieRotation.entities).toEqual([{ type: "minecraft:zombie", rotation: { x: 30, y: 90 }, nameTag: "" }]);
    expect(c.nameTag.entities).toEqual([{ type: "minecraft:armor_stand", rotation: { x: 0, y: 0 }, nameTag: "Named" }]);
    // 装備は replaceitem で書き、hasitem で読み戻せる（防具立て・ゾンビ）
    for (const tag of ["je2be_cmd_rot", "je2be_cmd_zrot"]) {
      for (const key of ["setMainhand", "setHead", "hasMainhand", "hasHead"]) {
        expect(c[`equipment_${tag}`][key], `${tag} ${key}`).toEqual({ ok: true, value: 1 });
      }
    }
  });
});
