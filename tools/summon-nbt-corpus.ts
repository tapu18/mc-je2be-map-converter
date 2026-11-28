// 配布マップの summon の NBT を、エンティティの種類別・トップレベルのキー別に数える（#357）。
// 使い方:
//   npm run setup:servers && npm run setup:mappings && npm run setup:grammars
//   python3 -I scripts/survey_corpus.py <sample-map> --commands <scratch>/commands.jsonl --definitions <scratch>/definitions.jsonl > <scratch>/inventory.json
//   node tools/summon-nbt-corpus.ts <scratch>/commands.jsonl [--json]
//
// 行の選び方は台帳（tools/compatibility-corpus.ts）と同じ：マクロ行を除き、版別文法で読めた行のうち、
// 終端の形が summon のものを数える（execute … run summon を含む）。そのため総数は台帳の frequency と一致する。
// 出力は件数と作品数だけ（コマンドの文面、作品名は出さない）。
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { textFormatFor, type NbtTag, type ParsedNode, type RewriteContext } from "@je2be/core";
import { loadJavaGrammars, loadRewriteContext } from "@je2be/converter";
import { join } from "node:path";
import { corpusContext, type CorpusVersion } from "./corpus-grammar.ts";
import { terminalShape } from "./compatibility-inventory.ts";

type CommandLine = CorpusVersion & { map: number; source: "cb" | "fn"; cmd: string };
type Count = { lines: number; maps: Set<number> };
type Summary = Record<string, { lines: number; maps: number }>;

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith("--"));
if (!input) {
  console.error("usage: node tools/summon-nbt-corpus.ts <commands.jsonl> [--json]");
  process.exit(2);
}

const root = join(import.meta.dirname, "..");
const servers = JSON.parse(readFileSync(join(root, "tools", "servers.json"), "utf8")) as { java: { version: string; dataVersion: number } };
const reports = join(root, "servers", `reports-${servers.java.version}`, "reports");
const base = loadRewriteContext({
  commandsJson: join(reports, "commands.json"), blocksJson: join(reports, "blocks.json"),
  mappingsJson: join(root, "servers", "mappings", "mappings.json"),
}, textFormatFor(servers.java.dataVersion));
const grammars = loadJavaGrammars();
if (!grammars.length) throw new Error("Run npm run setup:grammars first");
const contexts = new Map<string, RewriteContext>();

const add = (table: Map<string, Count>, key: string, map: number) => {
  const entry = table.get(key) ?? { lines: 0, maps: new Set<number>() };
  entry.lines++;
  entry.maps.add(map);
  table.set(key, entry);
};
const shapes = new Map<string, Count>();
const entities = new Map<string, Count>();
const keys = new Map<string, Count>();
const entityKeys = new Map<string, Count>();
const passengerKeys = new Map<string, Count>();
const versions = new Map<string, Count>();
const groups = new Map<string, Count>();
// BE に同じ種類がない Java 専用のエンティティ（packages/converter/src/placed-entities.ts の JAVA_ONLY と同じ）
const javaOnly = new Set(["minecraft:marker", "minecraft:interaction", "minecraft:block_display", "minecraft:item_display", "minecraft:text_display"]);
const keyCounts = new Map<string, Count>();
const skipped = { macro: 0, different: 0, unavailable: 0, invalid: 0 };

const namespaced = (id: string) => id.includes(":") ? id : "minecraft:" + id;

/** 最後の summon の entity と nbt を取り出す（execute … run summon の終端）。 */
function summonParts(nodes: readonly ParsedNode[]): { entity: string | undefined; nbt: NbtTag | undefined } {
  let command: string | undefined;
  let entity: string | undefined;
  let nbt: NbtTag | undefined;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (i === 0 || node.jump === "root") {
      command = node.name;
      if (command === "summon") { entity = undefined; nbt = undefined; }
    }
    if (command !== "summon") continue;
    if (node.name === "entity" && node.value?.kind === "resource") entity = namespaced(node.value.id);
    if (node.name === "nbt" && node.value?.kind === "nbt") nbt = node.value.value;
  }
  return { entity, nbt };
}

function passengers(tag: NbtTag, map: number): void {
  if (tag.type !== "compound") return;
  const list = tag.value.get("Passengers");
  if (list?.type !== "list") return;
  for (const child of list.value) {
    if (child.type !== "compound") continue;
    for (const key of child.value.keys()) add(passengerKeys, key, map);
    passengers(child, map);
  }
}

for await (const raw of createInterface({ input: createReadStream(input), crlfDelay: Infinity })) {
  if (!raw.trim()) continue;
  const row = JSON.parse(raw) as CommandLine;
  const text = row.cmd.trim();
  if (text.startsWith("$")) { skipped.macro++; continue; }
  const chosen = corpusContext(row, text, grammars, base, contexts);
  if (chosen.different) { skipped.different++; continue; }
  if (!chosen.context) { skipped.unavailable++; continue; }
  const parsed = chosen.context.parser.parse(text);
  if (!parsed.ok) { skipped.invalid++; continue; }
  const shape = terminalShape(chosen.context.parser.root, parsed.nodes);
  if (!shape?.startsWith("summon ")) continue;
  add(shapes, shape, row.map);
  const { entity, nbt } = summonParts(parsed.nodes);
  if (!nbt) continue;
  const version = [...contexts].find(([, context]) => context === chosen.context)?.[0] ?? "(不明)";
  add(versions, version, row.map);
  add(entities, entity ?? "(不明)", row.map);
  add(groups, entity && javaOnly.has(entity) ? "Java 専用（表示用・marker・interaction）" : "BE にもある種類", row.map);
  if (nbt.type !== "compound") continue;
  add(keyCounts, String(nbt.value.size), row.map);
  if (nbt.value.size === 0) add(keys, "(空)", row.map);
  for (const key of nbt.value.keys()) {
    add(keys, key, row.map);
    add(entityKeys, `${entity ?? "(不明)"} ${key}`, row.map);
  }
  passengers(nbt, row.map);
}

const summary = (table: Map<string, Count>): Summary => Object.fromEntries([...table]
  .sort(([a, x], [b, y]) => y.lines - x.lines || y.maps.size - x.maps.size || a.localeCompare(b))
  .map(([key, count]) => [key, { lines: count.lines, maps: count.maps.size }]));
const withNbt = [...shapes].filter(([shape]) => shape.includes(" nbt<"));
const result = {
  skipped,
  shapes: summary(shapes),
  nbtLines: withNbt.reduce((n, [, c]) => n + c.lines, 0),
  nbtMaps: new Set(withNbt.flatMap(([, c]) => [...c.maps])).size,
  grammarVersions: summary(versions),
  groups: summary(groups),
  topLevelKeyCount: summary(keyCounts),
  entities: summary(entities),
  keys: summary(keys),
  entityKeys: summary(entityKeys),
  passengerKeys: summary(passengerKeys),
};

if (args.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`NBT 付き summon: ${result.nbtLines} 行・${result.nbtMaps} 本（マクロ ${skipped.macro}、版で解釈が異なる ${skipped.different}、文法なし ${skipped.unavailable}、構文エラー ${skipped.invalid} 行は対象外）`);
  const table = (title: string, data: Summary, limit = Infinity) => {
    console.log(`\n## ${title}\n\n| キー | 行 | 作品 |\n| --- | ---: | ---: |`);
    for (const [key, { lines, maps }] of Object.entries(data).slice(0, limit)) console.log(`| \`${key}\` | ${lines} | ${maps} |`);
  };
  table("形", result.shapes);
  table("読んだ文法の版", result.grammarVersions);
  table("種類のまとまり", result.groups);
  table("トップレベルのキーの数", result.topLevelKeyCount);
  table("エンティティの種類", result.entities);
  table("トップレベルのキー", result.keys);
  table("種類とキーの組（上位 40）", result.entityKeys, 40);
  table("Passengers の中のキー", result.passengerKeys);
}
