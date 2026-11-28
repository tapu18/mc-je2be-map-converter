import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyReason, collectWarnings, describeScope, isJapanese, renderMarkdownReport, type WarningArea } from "./convert-report.ts";
import type { ConvertReport } from "./convert.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** 文字列リテラルの中身。テンプレートの ${…} は代表の値に置き換える。 */
const literals = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map(m => m[1]!.replace(/\$\{[^}]*\}/g, "x"));

/** 理由を出す箇所を読み、規則のない理由が足されたら落とす。 */
const sources: [WarningArea, string[]][] = [
  ["datapack", literals(source("./datapacks.ts"), /reason: "([^"]+)"/g)],
  ["datapack", literals(source("../../core/src/command/macro-template.ts"), /issue\(["`]([^"`]+)["`]/g)],
  ["datapack", ["unavailable", "ambiguous", "1.20.4 → 1.20.5: 旧アイテム tag を変換できない"]],
  ["entity", literals(source("./placed-entities.ts"), /skip\("([^"]+)"\)/g)],
  ["entity", literals(source("./placed-entities.ts"), /omit\([^,]+, [`"]([^`"]+)[`"]\)/g)],
  ["entity", ["テキストのセレクタ: x", "score の対象のセレクタ: x"]],
  ["chain", literals(source("./command-chains.ts"), /(?:return |reason: )[`"]([^`"]+)[`"]/g)],
  ["chain", literals(source("./command-rewrite.ts"), /reason: "([^"]+)"/g)],
  ["chain", ["ランタイムパックを初期化できない: Error: x", "ランタイムパックを生成しない呼び出し", "DataVersion 1 の文法がない。npm run setup:grammars で対象版を生成する",
    "unsupported entity NBT: writing entity NBT (data merge entity) is not supported"]],
  ["command_block", ["DataVersion 不明 の文法がない。npm run setup:grammars で対象版を生成する", "BE にチームはない（team=）", "26.2 → 26.3: x"]],
  ["score", literals(source("./convert.ts"), /reason: "([^"]+)"/g)],
  ["storage", ["Error: storage value is not a compound"]],
];

describe("警告コード", () => {
  it.each(sources.flatMap(([area, reasons]) => reasons.map(reason => [area, reason] as const)))("%s: %s に警告コードがある", (area, reason) => {
    expect(classifyReason(area, reason)).toMatchObject({ code: expect.stringMatching(/^[A-Z_]+$/), message: expect.stringMatching(/[ぁ-んァ-ヶ一-龠]/) });
  });

  it("理由を出す箇所を読み取れている", () => {
    for (const [area, reasons] of sources) expect(reasons.length, area).toBeGreaterThan(0);
    expect(sources.find(([area]) => area === "entity")![1]).toContain("Java 専用。代替エンティティの移植対象");
  });

  it("分類できない英語の理由は UNCLASSIFIED にして詳細を出さない", () => {
    const warnings = collectWarnings({ ...empty, datapacks: { functions: 0, omitted: [], diagnostics: [{ pack: "p", path: "x", reason: "brand new internal reason" }] } });
    expect(warnings).toMatchObject([{ code: "UNCLASSIFIED" }]);
    expect(renderMarkdownReport(empty, warnings, ctx)).not.toContain("brand new internal reason");
  });
});

const empty: ConvertReport = {
  scores: { objectives: 0, participants: 0, skipped: [] },
  storage: { entries: 0, errors: [] },
  entities: { scheduled: 0, skipped: [], fields: [] },
  datapacks: { functions: 0, omitted: [], diagnostics: [] },
};
const ctx = { dataVersion: 4790, converterVersion: "git test", chunkerVersion: "1.21.0", mappingJavaVersion: "26.3", mappingDataVersion: 4790 };

const report: ConvertReport = {
  scores: { objectives: 1, participants: 2, skipped: [{ objective: "kills", participant: "0b6d4e7a-1f2c-4d3e-9a8b-7c6d5e4f3a2b", reason: "UUID に対応する再配置対象がない" }] },
  storage: { entries: 1, errors: [{ source: "demo:data", reason: "Error: storage value is not a compound" }] },
  entities: {
    scheduled: 1,
    skipped: [{ type: "minecraft:marker", dimension: "minecraft:overworld", pos: { x: 1.5, y: 64, z: -2.25 }, field: "type", reason: "Java 専用。代替エンティティの移植対象" }],
    fields: [{ type: "minecraft:armor_stand", dimension: "minecraft:overworld", uuid: "u", pos: { x: 0, y: 64, z: 0 }, field: "NoGravity", reason: "保存値の復元は未対応" }],
  },
  datapacks: { functions: 3, omitted: ["advancement", "functions"], diagnostics: [
    { pack: "file/demo", path: "data/demo/function/a.mcfunction:2", reason: "command parse failed", command: "sya hi", error: "不明なコマンドかサブコマンド 'sya'（1文字目）" },
    { pack: "file/demo", path: "data/demo/function/m.mcfunction:1", reason: "macro hole can change command shape", start: 1, end: 9, command: "$$(cmd) hi" },
    { pack: "file/demo", path: "data/demo/tags/function/load.json", reason: "invalid tag JSON" },
  ] },
  commands: {
    textFormat: "json",
    counts: { rewritten: 0, unchanged: 1, unsupported: 2, invalid: 1 },
    commandBlocks: [
      { dimension: "minecraft:overworld", pos: [10, 64, 3], java: "say | hi", status: "unsupported", issues: [{ severity: "unsupported", message: "BE にチームはない（team=）" }] },
      { dimension: "minecraft:overworld", pos: [11, 64, 3], java: "foo", status: "invalid", issues: [], error: "不明なコマンドかサブコマンド 'foo'（0文字目）" },
      { dimension: "minecraft:the_nether", pos: [0, 70, 0], java: "data get storage a:b", status: "unsupported", bedrock: "je2be:run \"c0\"", issues: [{ severity: "unsupported", message: "storage は BE にない" }] },
    ],
    chains: [
      { head: { dimension: "minecraft:overworld", pos: [10, 64, 3] }, blocks: [[10, 64, 3]], status: "unsupported", reason: "unsupported entity NBT: writing entity NBT (data merge entity) is not supported", at: { dimension: "minecraft:overworld", pos: [10, 64, 3] } },
      { head: { dimension: "minecraft:the_nether", pos: [0, 70, 0] }, blocks: [[0, 70, 0]], status: "runtime", launcherId: "c0", reason: "BE コマンド 1 個に変換できない命令があり、チェーン全体をランタイムで実行する" },
      { head: { dimension: "minecraft:overworld", pos: [12, 64, 3] }, blocks: [[12, 64, 3]], status: "native", reason: "全コマンドを BE コマンドとして保持できる" },
    ],
  },
};

describe("Markdown のレポート", () => {
  const warnings = collectWarnings(report);
  const md = renderMarkdownReport(report, warnings, ctx);

  it("全項目に警告コードが付き、分類できないものがない", () => {
    expect(warnings.map(w => w.code)).not.toContain("UNCLASSIFIED");
    expect(warnings.map(w => w.code).sort()).toEqual([
      "CHAIN_ENTITY_NBT", "CHAIN_RUNTIME", "CMD_INVALID", "CMD_NOT_NATIVE", "CMD_NOT_NATIVE", "DP_FUNCTION_DIRECTORY", "DP_MACRO_SHAPE", "DP_OMITTED", "DP_PARSE_FAILED", "DP_TAG_JSON",
      "ENTITY_FIELD_NOT_RESTORED", "ENTITY_JAVA_ONLY", "SCORE_ENTITY_MISSING", "STORAGE_UNREADABLE",
    ]);
    // ランタイムで動くチェーンのブロックの書き換えの結果は要対応にしない。
    expect(warnings.find(w => w.where === "minecraft:the_nether (0, 70, 0)")).toMatchObject({ severity: "info" });
  });

  it("場所・元のコマンド・日本語の理由を示す", () => {
    expect(md).toContain("| minecraft:overworld (10, 64, 3) | `say \\| hi` | BE のコマンド 1 個に書き換えられない（詳細: BE にチームはない（team=）） |");
    expect(md).toContain("file/demo data/demo/function/a.mcfunction:2");
    expect(md).toContain("`sya hi`");
    expect(md).toContain("| minecraft:overworld (10, 64, 3) | `say \\| hi` | エンティティの NBT の読み書きのうち");
    expect(describeScope(report, ctx).notChecked).toContain("データパックの関数・関数タグ以外の内容（advancement）");
    expect(md).toContain("不明なコマンドかサブコマンド 'sya'");
    expect(md).toContain("file/demo data/demo/function/m.mcfunction:1（2〜9 文字目）");
    expect(md).toContain("| minecraft:overworld (1.50, 64, -2.25) | `minecraft:marker` | Java 専用のエンティティで、BE に同じものがない");
  });

  it("英語の内部の理由をそのまま出さない", () => {
    for (const english of ["command parse failed", "macro hole", "invalid tag JSON", "unsupported entity NBT", "writing entity NBT", "storage value is not a compound"]) {
      expect(md).not.toContain(english);
    }
    for (const w of warnings) expect(isJapanese(w.message)).toBe(true);
  });

  it("概要に版・範囲・件数を書き、警告がないことを保証と書かない", () => {
    expect(md).toContain("入力の版: DataVersion 4790");
    expect(md).toContain("変換器の版: git test（地形変換器 Chunker 1.21.0、ID の対応表 Java 26.3）");
    expect(md).toMatch(/要対応: 8 件、注意: 4 件、情報: 2 件/);
    expect(md).toContain("### 検査していない範囲");
    expect(md).toContain("ランタイムで実行するチェーンの BE 上の動作");
    expect(md).toContain("保証するものではありません");
    expect(md).not.toMatch(/動作を保証します|保証する。/);
  });

  it("行った処理から範囲を作る", () => {
    const scope = describeScope(empty, { ...ctx, dataVersion: 3700 });
    expect(scope.processed).toContain("有効なデータパックの関数はなかった");
    expect(scope.notChecked).toContain("コマンドブロックのコマンド（書き換えを行っていない）");
    expect(scope.notChecked.some(n => n.includes("Java 26.3 と異なる版"))).toBe(true);
    expect(describeScope(report, ctx).notChecked.some(n => n.includes("異なる版"))).toBe(false);
    expect(renderMarkdownReport(empty, [], ctx)).toContain("警告はありません。");
  });
});
