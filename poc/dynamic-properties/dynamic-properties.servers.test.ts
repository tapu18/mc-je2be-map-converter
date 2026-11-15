// #4: 動的プロパティの容量上限と、再起動・チャンクの読み込み直し後の復元。
// 結果は poc/dynamic-properties/results.json に書き出す（根拠としてコミットする）。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BedrockServer } from "@je2be/bridge";

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, "pack");

interface DpResponse {
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

describe("dynamic properties poc", () => {
  let bds: BedrockServer;
  let nextId = 1;
  const results: Record<string, unknown> = {};

  const dp = async (op: string, args: Record<string, unknown> = {}, timeoutMs = 240_000): Promise<DpResponse> => {
    const id = nextId++;
    bds.console(`scriptevent je2be:dp ${JSON.stringify({ id, op, ...args })}`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const l of bds.log) {
        const i = l.indexOf("POC_DP {");
        if (i < 0) continue;
        const res = JSON.parse(l.slice(i + 7)) as DpResponse;
        if (res.id === id) return res;
      }
      if (Date.now() > deadline) throw new Error(`timeout: ${op}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const waitEntity = async (tag: string, present: boolean): Promise<void> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await bds.request<unknown[]>("entities", { query: { tags: [tag] } });
      if ((res.result?.length ?? 0) > 0 === present) return;
      if (Date.now() > deadline) throw new Error(`entity ${tag} did not become ${present ? "loaded" : "unloaded"}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  beforeAll(async () => {
    bds = await BedrockServer.start({ behaviorPacks: [packDir] });
    await bds.exec("summon armor_stand 5 -60 5");
    await bds.exec("tag @e[type=armor_stand,x=5,y=-60,z=5,r=2] add dp_e");
  });

  afterAll(async () => {
    writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");
    await bds?.stop();
  });

  it("measures limits", async () => {
    results.worldMaxAscii = await dp("maxString", { target: "world", ch: "a", cap: 1 << 22 });
    results.worldMaxMultibyte = await dp("maxString", { target: "world", ch: "あ", cap: 1 << 22 });
    results.entityMaxAscii = await dp("maxString", { target: "dp_e", ch: "a", cap: 1 << 22 });
    results.worldTotal = await dp("total", { target: "world", chunk: 32_000, cap: 1 << 25 });
    results.entityTotal = await dp("total", { target: "dp_e", chunk: 32_000, cap: 1 << 25 });
    for (const k of ["worldMaxAscii", "worldMaxMultibyte", "entityMaxAscii", "worldTotal", "entityTotal"]) {
      expect((results[k] as DpResponse).ok, k).toBe(true);
    }

    // ---- 実測で確かめた事実 ----
    const r = (k: string): Record<string, unknown> => (results[k] as DpResponse).result!;
    // 文字列1件は UTF-8 で 32,767 バイトまで（文字数ではなくバイト数。3バイト文字なら 10,922 文字）。エンティティも同じ
    expect(r("worldMaxAscii").max).toBe(32767);
    expect(r("worldMaxMultibyte").max).toBe(10922);
    expect(r("entityMaxAscii").max).toBe(32767);
    // 合計は 32MB まで書いても上限に当たらない（ワールド・エンティティとも）
    expect(r("worldTotal")).toMatchObject({ reachedCap: true, afterClear: 0 });
    expect(r("entityTotal")).toMatchObject({ reachedCap: true, afterClear: 0 });
    expect(r("worldTotal").totalBytes as number).toBeGreaterThanOrEqual(1 << 25);
  });

  it("keeps values across restart and chunk reload", async () => {
    const big = 32_000;
    results.persistSet = {
      world: await dp("setRepeat", { target: "world", key: "persist", ch: "b", chunk: big }),
      entity: await dp("setRepeat", { target: "dp_e", key: "persist", ch: "c", chunk: 1000 }),
    };

    // チャンクの読み込み直し：読み込み範囲の外にエンティティを置き、一時的な ticking area を外して戻す
    await bds.exec("tickingarea add 300 0 300 300 0 300 dp_tmp");
    await waitEntityChunk(bds, [300, -61, 300]);
    await bds.exec("summon armor_stand 300 -60 300");
    await bds.exec("tag @e[type=armor_stand,x=300,y=-60,z=300,r=2] add dp_far");
    await waitEntity("dp_far", true);
    results.farSet = await dp("setRepeat", { target: "dp_far", key: "persist", ch: "d", chunk: 500 });
    await bds.exec("tickingarea remove dp_tmp");
    await waitEntity("dp_far", false);
    await bds.exec("tickingarea add 300 0 300 300 0 300 dp_tmp");
    await waitEntity("dp_far", true);
    results.farAfterReload = await dp("get", { target: "dp_far", key: "persist" });

    // 8MB 程度（32,000バイト × 256件）を書いてから再起動する
    results.bulkSet = await dp("fill", { target: "world", chunk: 32_000, cap: 256 });

    bds = await bds.restart();
    await waitEntity("dp_e", true);
    results.afterRestart = {
      world: await dp("get", { target: "world", key: "persist" }),
      entity: await dp("get", { target: "dp_e", key: "persist" }),
      bulk: await dp("count", { target: "world", chunk: 32_000 }),
    };

    // ---- 実測で確かめた事実：チャンクの読み込み直し、再起動の後も値は残る ----
    const res = results.afterRestart as Record<string, DpResponse>;
    expect((results.farAfterReload as DpResponse).result).toMatchObject({ type: "string", length: 500 });
    expect(res.world!.result).toMatchObject({ type: "string", length: 32000 });
    expect(res.entity!.result).toMatchObject({ type: "string", length: 1000 });
    expect(res.bulk!.result).toMatchObject({ keys: 256, intact: 256 });
  });
});

async function waitEntityChunk(bds: BedrockServer, pos: [number, number, number]): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!(await bds.request<boolean>("loaded", { pos })).result) {
    if (Date.now() > deadline) throw new Error(`chunk at ${pos} did not load`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
