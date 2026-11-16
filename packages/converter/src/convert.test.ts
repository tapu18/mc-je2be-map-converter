import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initScript, INIT_PROPERTY, SCRIPT_API_VERSION, selectScores, writeInitPack } from "./convert.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "je2be-convert-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("selectScores", () => {
  it("エンティティ（UUID）のスコアは除き、理由を残す", () => {
    const { objectives, skipped } = selectScores([
      { objective: "t", scores: [{ participant: "#a", score: 1 }, { participant: "0b6d4e7a-1f2c-4d3e-9a8b-7c6d5e4f3a2b", score: 2 }] },
    ]);
    expect(objectives).toEqual([{ objective: "t", scores: [{ participant: "#a", score: 1 }] }]);
    expect(skipped).toMatchObject([{ objective: "t", participant: "0b6d4e7a-1f2c-4d3e-9a8b-7c6d5e4f3a2b" }]);
  });
});

describe("初期化パック", () => {
  it("スクリプトはスコアを持ち、一度だけ動く", () => {
    const s = initScript([{ objective: "t", scores: [{ participant: "#a", score: -3 }] }]);
    expect(s).toContain('[["t",[["#a",-3]]]]');
    expect(s).toContain(`getDynamicProperty(${JSON.stringify(INIT_PROPERTY)})`);
  });

  it("world_behavior_packs.json の既存の記載を残して足す。同じ内容なら同じ UUID になる", () => {
    const w = tmp();
    writeFileSync(join(w, "world_behavior_packs.json"), JSON.stringify([{ pack_id: "other", version: [1, 0, 0] }]));
    writeInitPack(w, []);
    writeInitPack(w, []);
    const refs = JSON.parse(readFileSync(join(w, "world_behavior_packs.json"), "utf8")) as { pack_id: string }[];
    expect(refs.map((r) => r.pack_id)[0]).toBe("other");
    expect(refs).toHaveLength(2);
    const manifest = JSON.parse(readFileSync(join(w, "behavior_packs", "je2be_init", "manifest.json"), "utf8")) as { header: { uuid: string } };
    expect(refs[1]?.pack_id).toBe(manifest.header.uuid);
  });

  it("@minecraft/server の版は検証パックと同じ", () => {
    const m = JSON.parse(readFileSync(join(root, "packages/bridge-pack/pack/manifest.json"), "utf8")) as { dependencies: { module_name: string; version: string }[] };
    expect(m.dependencies.find((d) => d.module_name === "@minecraft/server")?.version).toBe(SCRIPT_API_VERSION);
  });
});
