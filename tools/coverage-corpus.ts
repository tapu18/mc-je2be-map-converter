// dump_commands.py のJSONLを読む。出力は集計値と文法上の型だけ。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CommandParser, selectCommandGrammar, type RewriteContext } from "@je2be/core";
import { loadJavaGrammars, loadGrammarTree, loadRewriteContext, staticCommandCoverage, type StaticStatus, type PlannedRoute } from "@je2be/converter";

const input = process.argv[2];
if (!input) throw new Error("usage: node tools/coverage-corpus.ts <commands.jsonl>");
const grammars = loadJavaGrammars();
if (!grammars.length) throw new Error("npm run setup:grammars を実行する");
// ID対応表はその元のJEレポートと一組。文法だけ各行の版に切り替える。
const fixed = JSON.parse(readFileSync(new URL("./servers.json", import.meta.url), "utf8")) as { java: { version: string } };
const root = fileURLToPath(new URL("../", import.meta.url));
const base = loadRewriteContext({ commandsJson: `${root}servers/reports-${fixed.java.version}/reports/commands.json`,
  blocksJson: `${root}servers/reports-${fixed.java.version}/reports/blocks.json`, mappingsJson: `${root}servers/mappings/mappings.json` }, "snbt");
const contexts = new Map<string, RewriteContext>();
const statuses: StaticStatus[] = ["unchanged", "rewritten", "unsupported", "invalid", "macro", "unavailable"];
const routes: PlannedRoute[] = ["native-candidate", "runtime-required", "unresolved"];
const empty = () => ({ total: 0, warnings: 0, statuses: Object.fromEntries(statuses.map(s => [s, 0])) as Record<StaticStatus, number>, routes: Object.fromEntries(routes.map(s => [s, 0])) as Record<PlannedRoute, number> });
const all = empty();
const byMap = new Map<number, ReturnType<typeof empty>>();
const bySource = new Map<string, ReturnType<typeof empty>>();
const patterns = new Map<string, { cb: number; fn: number }>();
for (const line of readFileSync(input, "utf8").split("\n").filter(s => s.trim())) {
  const row = JSON.parse(line) as { map: number; source: "cb" | "fn"; cmd: string; dataVersion: number | null; packFormat: number | null };
  if (!Number.isSafeInteger(row.map) || !["cb", "fn"].includes(row.source) || typeof row.cmd !== "string") throw new Error("invalid corpus row");
  const selection = selectCommandGrammar(grammars, { ...(row.dataVersion === null ? {} : { dataVersion: row.dataVersion }), ...(row.packFormat === null ? {} : { packFormat: row.packFormat }) });
  let context: RewriteContext | undefined;
  if (selection.ok) {
    const g = selection.grammar;
    context = contexts.get(g.version);
    if (!context) { context = { ...base, parser: new CommandParser(loadGrammarTree(g), { textFormat: g.textFormat }) }; contexts.set(g.version, context); }
  }
  const verdict = staticCommandCoverage(row.cmd, row.source, context);
  if (!byMap.has(row.map)) byMap.set(row.map, empty());
  if (!bySource.has(row.source)) bySource.set(row.source, empty());
  for (const tally of [all, byMap.get(row.map)!, bySource.get(row.source)!]) {
    tally.total++; tally.statuses[verdict.status]++; tally.routes[verdict.route]++;
    if (verdict.warnings) tally.warnings++;
  }
  if (verdict.pattern) { const count = patterns.get(verdict.pattern) ?? { cb: 0, fn: 0 }; count[row.source]++; patterns.set(verdict.pattern, count); }
}
const percent = (n: number, d: number) => d ? `${(100 * n / d).toFixed(2)}%` : "-";
console.log("静的な行単位の出力可否。実行成功・チェーンの出力可否・クリア可能性ではない。ランタイムは未実装。\n");
console.log(`ID対応とブロック既定値は固定JE ${fixed.java.version} の資材を使用。旧版のID・状態との差は未対応に含み得る。\n`);
console.log("| 区分 | 行数 | 無変更で出力 | 書換で出力 | 未対応 | 構文不受理 | マクロ | 文法なし | パース成功率 | 出力可能率 | 警告あり |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const [label, t] of [["全体", all], ...bySource, ...[...byMap].sort(([a], [b]) => a - b).map(([n, t]) => [`map-${n}`, t])] as [string, ReturnType<typeof empty>][]) {
  const s = t.statuses; const parsed = s.unchanged + s.rewritten + s.unsupported;
  console.log(`| ${label} | ${t.total} | ${s.unchanged} | ${s.rewritten} | ${s.unsupported} | ${s.invalid} | ${s.macro} | ${s.unavailable} | ${percent(parsed, parsed + s.invalid)} | ${percent(s.unchanged + s.rewritten, t.total)} | ${t.warnings} |`);
}
console.log("\n設計上の経路（別集計、全行を分母）。関数は出力可能な行もランタイムへ。CBのnativeはチェーン確認前の候補。\n\n| 経路 | 行数 | 全行比 |\n| --- | ---: | ---: |");
for (const route of routes) console.log(`| ${route} | ${all.routes[route]} | ${percent(all.routes[route], all.total)} |`);
console.log("\n未対応の型（上位25、重複を除かず行数で集計。引数の値は掲載しない）\n\n| 型 | CB | 関数 | 合計 |\n| --- | ---: | ---: | ---: |");
for (const [pattern, count] of [...patterns].sort(([, a], [, b]) => b.cb + b.fn - a.cb - a.fn).slice(0, 25)) console.log(`| \`${pattern.replaceAll("|", "\\|")}\` | ${count.cb} | ${count.fn} | ${count.cb + count.fn} |`);
