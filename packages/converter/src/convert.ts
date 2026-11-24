// Java ワールドを BE ワールドに変換する（#61、design.md 4章・5.10）。
// 地形・ブロック・コマンドブロックは Chunker に任せ、スコアとエンティティは、
// BE の初回読み込み時に書き込むビヘイビアーパック（初期化パック）として出す。
// コマンドブロックのコマンドは、Chunker に渡す前の Java ワールドのコピーで BE の書き方に書き換える（#62）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nbt, readBedrockLevelDat, writeBedrockLevelDat, type MappingTables, type ObjectiveScores, type NbtTag } from "@je2be/core";
import { rewriteWorldCommands, type CommandRewriteReport, type RewriteResources } from "./command-rewrite.ts";
import { collectDatapacks } from "./datapacks.ts";
import { JavaWorld } from "./java-world.ts";
import { collectPlacedEntities, type PlacedEntity, type PlacedEntityReport } from "./placed-entities.ts";
import { fileURLToPath } from "node:url";

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
  /** コマンドの書き換えに使う文法・対応表。省略するとコマンドを書き換えない */
  rewrite?: RewriteResources;
}

export interface SkippedScore {
  objective: string;
  participant: string;
  reason: string;
}

export interface ConvertReport {
  /** 初期化パックに入れた目的変数と参加者の数 */
  scores: { objectives: number; participants: number; skipped: SkippedScore[] };
  entities: PlacedEntityReport;
  datapacks: ReturnType<typeof collectDatapacks>["report"];
  /** コマンドブロックの書き換え（rewrite を渡したときだけ） */
  commands?: CommandRewriteReport;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID のスコアを、再配置時に BE のエンティティへ設定する。 */
export function selectScores(scores: ObjectiveScores[], entities: PlacedEntity[] = []): { objectives: ObjectiveScores[]; skipped: SkippedScore[] } {
  const byUuid = new Map(entities.filter((e) => e.uuid).map((e) => [e.uuid, e]));
  const skipped: SkippedScore[] = [];
  const objectives = scores.map((o) => ({
    objective: o.objective,
    scores: o.scores.filter((s) => {
      if (!UUID.test(s.participant)) return true;
      const entity = byUuid.get(s.participant.toLowerCase());
      if (entity) entity.scores.push([o.objective, s.score]);
      else skipped.push({ objective: o.objective, participant: s.participant, reason: "UUID に対応する再配置対象がない" });
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

/** 初期化パックを BE ワールドの behavior_packs/ に置き、world_behavior_packs.json に足す */
export function writeInitPack(worldDir: string, objectives: ObjectiveScores[], entities: PlacedEntity[] = [], datapackData = ""): void {
  const chunk = (n: number) => Math.floor(n / 16);
  const sorted = [...entities].sort((a, b) => a.dimension.localeCompare(b.dimension) || chunk(a.pos.x) - chunk(b.pos.x) || chunk(a.pos.z) - chunk(b.pos.z));
  const data = `export const objectives = ${JSON.stringify(objectives.map((o) => [o.objective, o.scores.map((s) => [s.participant, s.score])]))};\nexport const entities = ${JSON.stringify(sorted)};\n`;
  const scriptsDir = fileURLToPath(new URL("../../runtime-host/pack/scripts/", import.meta.url));
  const files = ["main.js"];
  const script = files.map((file) => readFileSync(join(scriptsDir, file), "utf8")).join("\n") + data;
  const uuid = stableUuid(`pack:${script}:${datapackData}`);
  const dir = join(worldDir, "behavior_packs", "je2be_init");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const version = [0, 1, 0];
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        format_version: 2,
        header: { name: "je2be init", description: "Java ワールドのエンティティとスコアを復元する（je2be が生成）", uuid, version, min_engine_version: [1, 26, 60] },
        modules: [{ type: "script", language: "javascript", uuid: stableUuid(`module:${script}:${datapackData}`), version, entry: "scripts/main.js" }],
        dependencies: [{ module_name: "@minecraft/server", version: SCRIPT_API_VERSION }],
      },
      null,
      2,
    ),
  );
  for (const file of files) cpSync(join(scriptsDir, file), join(dir, "scripts", file));
  writeFileSync(join(dir, "scripts", "data.js"), data);
  const refsPath = join(worldDir, "world_behavior_packs.json");
  const refs = existsSync(refsPath) ? (JSON.parse(readFileSync(refsPath, "utf8")) as { pack_id: string; version: number[] }[]) : [];
  writeFileSync(refsPath, JSON.stringify([...refs.filter((r) => r.pack_id !== uuid), { pack_id: uuid, version }], null, 2));
}

/** 生成パックが要求するBeta APIsと、移植したコマンドブロックの実行を出力ワールド自身で許可する。 */
export function configureOutputWorld(worldDir: string): void {
  const file = join(worldDir, "level.dat");
  const level = readBedrockLevelDat(new Uint8Array(readFileSync(file)));
  const root = level.root.tag.value;
  const previous = root.get("experiments");
  const experiments = new Map<string, NbtTag>(previous?.type === "compound" ? previous.value : []);
  experiments.set("gametest", nbt.byte(1));
  experiments.set("experiments_ever_used", nbt.byte(1));
  experiments.set("saved_with_toggled_experiments", nbt.byte(1));
  root.set("experiments", nbt.compound(experiments));
  for (const key of ["cheatsEnabled", "commandsEnabled", "commandblocksenabled"]) root.set(key, nbt.byte(1));
  writeFileSync(file, writeBedrockLevelDat(level));
}

/** Java ワールド（ディレクトリ）を BE ワールド（ディレクトリ）に変換する */
export function convertWorld(javaDir: string, outDir: string, opts: ConvertOptions): ConvertReport {
  const datapacks = collectDatapacks(javaDir);
  const source = new JavaWorld(javaDir);
  const version = source.dataVersion();
  // エンティティが terrain region から専用 region に移ったのは Java 1.17。
  const legacy = version === undefined || version < 2724;
  const items = opts.rewrite ? (JSON.parse(readFileSync(opts.rewrite.mappingsJson, "utf8")) as MappingTables).items : [];
  const placed = collectPlacedEntities(source, legacy, version, items);
  const hasEntities = placed.report.scheduled > 0 || placed.report.skipped.length > 0;
  const { objectives, skipped } = selectScores(source.scoreboard(), placed.entities);
  const work = opts.rewrite || hasEntities ? mkdtempSync(join(tmpdir(), "je2be-convert-")) : undefined;
  try {
    let input = javaDir;
    let commands: CommandRewriteReport | undefined;
    if (work) {
      input = join(work, "java");
      cpSync(javaDir, input, { recursive: true, dereference: true });
      if (hasEntities) new JavaWorld(input).removeEntitiesFromChunkerCopy(legacy);
      if (opts.rewrite) commands = rewriteWorldCommands(input, opts.rewrite);
    }
    execFileSync(opts.java, ["-jar", opts.chunkerJar, "-i", input, "-f", opts.format ?? DEFAULT_CHUNKER_FORMAT, "-o", outDir], {
      stdio: "pipe",
      timeout: 600_000,
    });
    if (!existsSync(join(outDir, "level.dat"))) throw new Error(`Chunker の出力に level.dat がない: ${outDir}`);
    const datapackData = JSON.stringify({ schemaVersion: 1, packs: datapacks.packs });
    writeInitPack(outDir, objectives, placed.entities, datapackData);
    writeFileSync(join(outDir, "behavior_packs", "je2be_init", "scripts", "datapacks.js"), `export const datapacks = ${datapackData};\n`);
    configureOutputWorld(outDir);
    return {
      scores: { objectives: objectives.length, participants: objectives.reduce((n, o) => n + o.scores.length, 0)
        + placed.entities.reduce((n, e) => n + e.scores.length, 0), skipped },
      entities: placed.report,
      datapacks: datapacks.report,
      ...(commands ? { commands } : {}),
    };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}
