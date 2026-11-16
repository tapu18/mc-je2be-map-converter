// Java ワールドを BE ワールドに変換する（#61、design.md 4章・5.10）。
// 地形・ブロック・コマンドブロックは Chunker に任せ、Chunker が運ばないスコアは、
// BE の初回読み込み時に書き込むビヘイビアーパック（初期化パック）として出す。
// コマンドの書き換えはまだしない（#62）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectiveScores } from "@je2be/core";
import { JavaWorld } from "./java-world.ts";

/** 初期化パックが使う @minecraft/server の版。bridge-pack と同じ版に保つ（convert.test.ts で確かめる） */
export const SCRIPT_API_VERSION = "2.12.0-beta";
/** Chunker の出力形式の既定値（BE 1.26.60 形式。#6 で確かめたもの） */
export const DEFAULT_CHUNKER_FORMAT = "BEDROCK_R26_60";
/** 初期化パックが一度だけ動いたことを記録する動的プロパティ */
export const INIT_PROPERTY = "je2be:initialized";
/** 初期化を終えたときにコンテンツログへ出す印 */
export const INIT_LOG_MARK = "[je2be] initialized";

export interface ConvertOptions {
  /** java コマンドのパス（Chunker を動かす） */
  java: string;
  /** Chunker の CLI の jar */
  chunkerJar: string;
  /** Chunker の出力形式（既定 BEDROCK_R26_60） */
  format?: string;
}

export interface SkippedScore {
  objective: string;
  participant: string;
  reason: string;
}

export interface ConvertReport {
  /** 初期化パックに入れた目的変数と参加者の数 */
  scores: { objectives: number; participants: number; skipped: SkippedScore[] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 初期化パックに入れるスコアを選ぶ。エンティティ（UUID）のスコアは、エンティティを再配置するまで運べない */
export function selectScores(scores: ObjectiveScores[]): { objectives: ObjectiveScores[]; skipped: SkippedScore[] } {
  const skipped: SkippedScore[] = [];
  const objectives = scores.map((o) => ({
    objective: o.objective,
    scores: o.scores.filter((s) => {
      if (!UUID.test(s.participant)) return true;
      skipped.push({ objective: o.objective, participant: s.participant, reason: "エンティティのスコア（エンティティの再配置は未対応）" });
      return false;
    }),
  }));
  return { objectives, skipped };
}

/** 内容から決まる UUID（同じ入力なら同じパックになるように） */
function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 初期化パックのスクリプト。ワールドの初回読み込みで目的変数を作り、スコアを書き込む */
export function initScript(objectives: ObjectiveScores[]): string {
  const data = JSON.stringify(objectives.map((o) => [o.objective, o.scores.map((s) => [s.participant, s.score])]));
  return `// je2be が生成した初期化スクリプト。Java ワールドのスコアを、BE の初回読み込み時に書き込む
import { world } from "@minecraft/server";

const OBJECTIVES = ${data};

world.afterEvents.worldLoad.subscribe(() => {
  if (world.getDynamicProperty(${JSON.stringify(INIT_PROPERTY)})) return;
  let count = 0;
  for (const [id, scores] of OBJECTIVES) {
    const objective = world.scoreboard.getObjective(id) ?? world.scoreboard.addObjective(id, id);
    for (const [participant, score] of scores) {
      objective.setScore(participant, score);
      count++;
    }
  }
  world.setDynamicProperty(${JSON.stringify(INIT_PROPERTY)}, true);
  console.warn(${JSON.stringify(INIT_LOG_MARK)} + " " + count + " scores");
});
`;
}

/** 初期化パックを BE ワールドの behavior_packs/ に置き、world_behavior_packs.json に足す */
export function writeInitPack(worldDir: string, objectives: ObjectiveScores[]): void {
  const script = initScript(objectives);
  const uuid = stableUuid(`pack:${script}`);
  const dir = join(worldDir, "behavior_packs", "je2be_init");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const version = [0, 1, 0];
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        format_version: 2,
        header: { name: "je2be init", description: "Java ワールドのスコアを書き込む（je2be が生成）", uuid, version, min_engine_version: [1, 26, 60] },
        modules: [{ type: "script", language: "javascript", uuid: stableUuid(`module:${script}`), version, entry: "scripts/main.js" }],
        dependencies: [{ module_name: "@minecraft/server", version: SCRIPT_API_VERSION }],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "scripts", "main.js"), script);
  const refsPath = join(worldDir, "world_behavior_packs.json");
  const refs = existsSync(refsPath) ? (JSON.parse(readFileSync(refsPath, "utf8")) as { pack_id: string; version: number[] }[]) : [];
  writeFileSync(refsPath, JSON.stringify([...refs.filter((r) => r.pack_id !== uuid), { pack_id: uuid, version }], null, 2));
}

/** Java ワールド（ディレクトリ）を BE ワールド（ディレクトリ）に変換する */
export function convertWorld(javaDir: string, outDir: string, opts: ConvertOptions): ConvertReport {
  execFileSync(opts.java, ["-jar", opts.chunkerJar, "-i", javaDir, "-f", opts.format ?? DEFAULT_CHUNKER_FORMAT, "-o", outDir], {
    stdio: "pipe",
    timeout: 600_000,
  });
  if (!existsSync(join(outDir, "level.dat"))) throw new Error(`Chunker の出力に level.dat がない: ${outDir}`);
  const { objectives, skipped } = selectScores(new JavaWorld(javaDir).scoreboard());
  writeInitPack(outDir, objectives);
  return {
    scores: { objectives: objectives.length, participants: objectives.reduce((n, o) => n + o.scores.length, 0), skipped },
  };
}
