import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { rewriteCommand, textFormatFor, type MappingTables } from "@je2be/core";
import { loadRewriteContext } from "@je2be/converter";
import { attachCorpus } from "./compatibility-corpus.ts";
import { executableShapes, methods, probeShape, registries, rowKey, textActions, unknown, type Family, type Row, type Verdict } from "./compatibility-inventory.ts";

const { values } = parseArgs({ options: {
  out: { type: "string" },
  commands: { type: "string" },
  definitions: { type: "string" },
  previous: { type: "string" },
} });
if (!values.out || Boolean(values.commands) !== Boolean(values.definitions)) {
  throw new Error("Usage: npm run ledger:compatibility -- --out DIR [--commands PRIVATE.jsonl --definitions PRIVATE.jsonl] [--previous LEDGER.jsonl]");
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const root = fileURLToPath(new URL("../", import.meta.url));
const versions = readJson<{ java: { version: string; dataVersion: number }; bedrock: { version: string } }>(join(root, "tools/servers.json"));
const java = versions.java.version;
const bedrock = versions.bedrock.version;
const reports = join(root, "servers", `reports-${java}`, "reports");
const mappingsJson = join(root, "servers/mappings/mappings.json");
const mappings = readJson<MappingTables>(mappingsJson);
if (mappings.source.javaVersion !== java || !mappings.sounds || !mappings.particles) {
  throw new Error("Run npm run setup:mappings with the matching Java reports");
}
const context = loadRewriteContext({
  commandsJson: join(reports, "commands.json"), blocksJson: join(reports, "blocks.json"), mappingsJson,
}, textFormatFor(versions.java.dataVersion));
const registryData = readJson<Record<string, { entries: Record<string, unknown> }>>(join(reports, "registries.json"));
const packFormat = readJson<{ registries: Record<string, { elements: boolean }> }>(join(reports, "datapack.json"));
for (const category of ["advancement", "predicate", "loot_table"]) {
  if (!packFormat.registries["minecraft:" + category]?.elements) {
    throw new Error(`Java datapack report no longer declares ${category} elements`);
  }
}

const fixedTests = java === "26.3" && bedrock === "1.26.63.1";
const fixedIds = mappings.source.revision === "e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7";
const rewriteTest = "packages/bridge/src/rewrite.servers.test.ts";
const soundTest = "packages/bridge/src/sound-particles.servers.test.ts";
const particleLoss = ["particle options (including color where applicable)", "delta", "speed", "count", "force", "viewers"];
const customEntities = new Set(["marker", "interaction", "text_display", "item_display", "block_display"].map(id => "minecraft:" + id));

function registryVerdict(family: Family, id: string): Verdict {
  if (family === "particle" || family === "sound") {
    const target = family === "particle" ? context.mappings.particle(id) : context.mappings.sound(id);
    const loss = family === "particle" ? particleLoss : ["sound category"];
    if (!target) {
      const value = unknown("Geyser fixed command mapping", 90);
      value.evidence.scope = "No command mapping in the fixed table";
      value.loss = loss;
      return value;
    }
    return {
      method: "approximation", implementation: "partial", loss, issue: 90,
      evidence: fixedTests && fixedIds
        ? { confidence: "measured", source: soundTest, scope: "Mapped command has BDS successCount 1; nonexistent IDs do too. Rendering/playback and equivalence unverified" }
        : { confidence: "unconfirmed", source: "Geyser fixed command mapping", scope: "Mapped ID; rendering/playback and equivalence unverified" },
    };
  }
  if (family === "entity" || family === "effect") {
    const probe = family === "entity" ? `execute if entity @e[type=${id}]` : `effect give @e[type=pig] ${id} 20`;
    const result = rewriteCommand(probe, context);
    const scope = family === "entity" ? "BDS selector accepts type; placement, NBT and behavior unverified"
      : "BDS command applies effect to pig; equivalence unverified";
    if (result.status === "rewritten" || result.status === "unchanged") return {
      method: "rewrite", implementation: "partial", loss: null, issue: 72,
      evidence: fixedTests ? { confidence: "measured", source: rewriteTest, scope }
        : { confidence: "unconfirmed", source: "packages/core/src/command/bedrock-command-ids.ts", scope: "Existing command ID translation; target version unverified" },
    };
    if (family === "entity" && customEntities.has(id)) {
      return { method: "asset", implementation: "planned", loss: null, issue: null,
        evidence: { confidence: "estimated", source: "docs/design.md §5.8", scope: "Custom entity candidate; behavior and data migration unverified" } };
    }
    if (fixedTests) {
      const value = unknown(rewriteTest, 72);
      value.evidence = { confidence: "measured", source: rewriteTest,
        scope: "BDS rejects the same-name ID in the existing command probe; replacement uninvestigated" };
      return value;
    }
  }
  if (family === "game_rule" && id === "minecraft:keep_inventory") {
    return { method: "rewrite", implementation: "partial", loss: null, issue: 72,
      evidence: fixedTests
        ? { confidence: "measured", source: rewriteTest, scope: "BDS accepts the rewritten keepInventory setting" }
        : { confidence: "unconfirmed", source: "packages/core/src/command/rewrite.ts", scope: "Existing command spelling translation" } };
  }
  return unknown("Java registry");
}

const rows = new Map<string, Row>();
function add(family: Family, id: string, javaSource: string, verdict: Verdict): void {
  const key = rowKey(family, id);
  if (rows.has(key)) throw new Error(`Duplicate inventory item ${key}`);
  rows.set(key, { family, id, javaSource, ...verdict, frequency: null });
}

for (const [id, path] of executableShapes(context.parser.root)) {
  add("command", id, "commands.json", probeShape(context, id, path));
}
for (const [family, registry] of Object.entries(registries) as [keyof typeof registries, string][]) {
  const entries = registryData["minecraft:" + registry]?.entries;
  if (!entries || !Object.keys(entries).length) throw new Error(`Missing or empty Java registry: ${registry}`);
  for (const id of Object.keys(entries)) add(family, id, `registries.json#minecraft:${registry}`, registryVerdict(family, id));
}
const jar = join(root, "servers", `java-${java}`, "versions", java, `server-${java}.jar`);
for (const [family, kind] of [["click", "Click"], ["hover", "Hover"]] as const) {
  for (const id of textActions(jar, kind)) {
    add(family, id, `${kind}Event$Action`, { method: "uninvestigated", implementation: "loss-only", loss: [`${family} action`], issue: null,
      evidence: { confidence: "unconfirmed", source: "packages/core/src/command/rawtext.ts", scope: "Rawtext conversion drops the event with a warning; UI replacement uninvestigated" } });
  }
}

const corpus = values.commands && values.definitions
  ? await attachCorpus(rows, { commands: values.commands, definitions: values.definitions }, context) : null;
const sorted = [...rows.keys()].sort().map(key => rows.get(key)!);
const jsonLines = (items: readonly unknown[]) => items.map(item => JSON.stringify(item) + "\n").join("");
const percent = (n: number, d: number) => d ? (100 * n / d).toFixed(2) + "%" : "—";
const showCount = (n: number | null) => n ?? "—";
const hasOutput = (row: Row) => row.implementation === "partial" || row.implementation === "output";
const md = (value: string) => value.replaceAll("|", "\\|");

function summary(): string {
  const lines = [
    "# 互換性台帳の集計",
    "",
    `Java ${java} / BDS ${bedrock} / Geyser \`${mappings.source.revision}\`。再生成手順と数値の範囲は [互換性台帳](compatibility-ledger.md)。`,
    "",
    "| 族 | 項目数 | 方式の内訳 | 台帳に対応づいた行・定義ファイル | 出力あり項目の頻度比 | 作品数 |",
    "| --- | ---: | --- | ---: | ---: | ---: |",
  ];
  const weighted = (group: Row[], field: "lines" | "definitions") => {
    const observed = group.filter(row => row.frequency?.[field] != null);
    const count = observed.reduce((sum, row) => sum + row.frequency![field]!, 0);
    const output = observed.filter(hasOutput).reduce((sum, row) => sum + row.frequency![field]!, 0);
    return { count: observed.length ? count : null, percent: percent(output, count) };
  };
  for (const family of [...new Set(sorted.map(row => row.family))]) {
    const group = sorted.filter(row => row.family === family);
    const countByMethod = methods.map(method => [method, group.filter(row => row.method === method).length] as const);
    const line = weighted(group, "lines");
    const definition = weighted(group, "definitions");
    const maps = corpus ? (corpus.familyMaps[family] ?? 0) : null;
    lines.push(`| ${family} | ${group.length} | ${countByMethod.filter(([, count]) => count).map(([m, count]) => `${m} ${count}`).join(" / ")} | ${showCount(line.count)} 行・${showCount(definition.count)} 定義 | ${line.percent === "—" ? definition.percent : line.percent} | ${showCount(maps)} |`);
  }
  lines.push("", "| 方式 | 全項目数 |", "| --- | ---: |");
  for (const method of methods) lines.push(`| ${method} | ${sorted.filter(row => row.method === method).length} |`);
  lines.push(`| 合計 | ${sorted.length} |`);

  if (corpus) {
    const t = corpus.commands;
    lines.push("", `入力があったアーカイブ ${corpus.archivesWithInput} 本、進捗・predicate・ルートテーブル定義 ${corpus.definitionFiles} ファイル。`,
      `全 ${t.total} 行のうち、版選択不能 ${t.unavailable}、範囲内で結果が異なる ${t.different}、マクロ ${t.macro}、構文不受理 ${t.invalid}、パース済みで形が対応づかない ${t.unmatched}。`,
      `形が対応づいた ${t.matched} 行で書き換え器が出力したのは ${t.output} 行（${percent(t.output, t.matched)}、全入力の ${percent(t.output, t.total)}）。うち警告付き ${t.outputWithWarnings} 行。`);
    for (const [field, label] of [["lines", "行数"], ["definitions", "定義ファイル数"]] as const) {
      lines.push("", `## 未調査の頻度上位20件（${label}）`, "", `| 族 | 項目 | ${label} | 作品数 |`, "| --- | --- | ---: | ---: |");
      const top = sorted.filter(row => row.method === "uninvestigated" && (row.frequency?.[field] ?? 0) > 0)
        .sort((a, b) => b.frequency![field]! - a.frequency![field]! || b.frequency!.maps - a.frequency!.maps).slice(0, 20);
      for (const row of top) lines.push(`| ${row.family} | \`${md(row.id)}\` | ${row.frequency![field]} | ${row.frequency!.maps} |`);
    }
  }
  return lines.join("\n") + "\n";
}

function diff(previous: string) {
  const old = new Map<string, Row>();
  for (const line of readFileSync(previous, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as Row;
    const key = rowKey(row.family, row.id);
    if (old.has(key)) throw new Error("Duplicate item in previous ledger");
    old.set(key, row);
  }
  const verdict = ({ method, implementation, loss, issue, evidence }: Row): Verdict => ({ method, implementation, loss, issue, evidence });
  const added: string[] = [];
  const removed = [...old.keys()].filter(key => !rows.has(key)).sort();
  const changed: { key: string; before: Verdict; after: Verdict }[] = [];
  for (const row of sorted) {
    const key = rowKey(row.family, row.id);
    const before = old.get(key);
    if (!before) added.push(key);
    else if (JSON.stringify(verdict(before)) !== JSON.stringify(verdict(row))) changed.push({ key, before: verdict(before), after: verdict(row) });
  }
  return { added, removed, changed };
}

const changes = values.previous ? diff(values.previous) : undefined;
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "compatibility.jsonl"), jsonLines(sorted));
writeFileSync(join(values.out, "compatibility-summary.md"), summary());
writeFileSync(join(values.out, "compatibility-sources.json"), JSON.stringify({
  schemaVersion: 1, java: versions.java, bedrock: versions.bedrock, geyser: mappings.source, corpus,
}, null, 2) + "\n");
if (changes) writeFileSync(join(values.out, "compatibility-diff.json"), JSON.stringify(changes, null, 2) + "\n");
