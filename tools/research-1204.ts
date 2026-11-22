// #145: 非公開 JSONL を読み、コマンド本文を出さずに集計する。
import { readFileSync } from "node:fs";
import { CommandParser, type CommandTreeNode } from "@je2be/core";
import { loadRewriteContext, staticCommandCoverage } from "@je2be/converter";

const input = process.argv[2];
if (!input) throw new Error("usage: node tools/research-1204.ts <private-jsonl>");
const report = (version: string) => `servers/grammars/${version}/generated/reports/commands.json`;
type Tree = { type: string; parser?: string; properties?: unknown; executable?: boolean; redirect?: string[]; children?: Record<string, Tree> };
function shapes(file: string): Set<string> {
  const result = new Set<string>();
  function visit(n: Tree, path: string[], name = "") {
    const next = n.type === "root" ? path : [...path, n.type === "literal" ? name : `<${n.parser}:${JSON.stringify(n.properties ?? {})}>`];
    if (n.executable) result.add(next.join(" "));
    if (n.redirect) result.add(`${next.join(" ")} -> ${n.redirect.join(" ")}`);
    for (const [key, child] of Object.entries(n.children ?? {})) visit(child, next, key);
  }
  visit(JSON.parse(readFileSync(file, "utf8")) as Tree, []);
  return result;
}
const old = shapes(report("1.20.4")); const newer = shapes(report("1.20.5"));
const common = [...old].filter(s => newer.has(s)).length;
const base = loadRewriteContext({ commandsJson: "servers/reports-26.3/reports/commands.json", blocksJson: "servers/reports-26.3/reports/blocks.json", mappingsJson: "servers/mappings/mappings.json" }, "json");
const context = { ...base, parser: new CommandParser(JSON.parse(readFileSync(report("1.20.4"), "utf8")) as CommandTreeNode, { textFormat: "json" }) };
const statuses: Record<string, number> = {};
const markers = { itemBraces: 0, itemComponents: 0, tagPath: 0, componentsPath: 0, textCommand: 0 };
const parsedMarkers = { itemComponents: 0, tagPath: 0, componentsPath: 0, text: 0 };
let total = 0;
for (const line of readFileSync(input, "utf8").split("\n").filter(Boolean)) {
  const row = JSON.parse(line) as { dataVersion: number | null; source: "cb" | "fn"; cmd: string };
  if (row.dataVersion !== 3700) continue;
  total++;
  const status = staticCommandCoverage(row.cmd, row.source, context).status;
  statuses[status] = (statuses[status] ?? 0) + 1;
  if (status !== "macro") {
    const parsed = context.parser.parse(row.cmd);
    if (parsed.ok) {
      const values = parsed.nodes.map(n => n.value);
      if (values.some(v => v?.kind === "item" && v.components.length > 0 || v?.kind === "itemPredicate" && v.alternatives.length > 0)) parsedMarkers.itemComponents++;
      if (values.some(v => v?.kind === "nbtPath" && v.path.some(p => p.kind === "key" && p.key === "tag"))) parsedMarkers.tagPath++;
      if (values.some(v => v?.kind === "nbtPath" && v.path.some(p => p.kind === "key" && p.key === "components"))) parsedMarkers.componentsPath++;
      if (values.some(v => v?.kind === "text")) parsedMarkers.text++;
    }
  }
  // 表層一致の下限・候補数。文法解析できない行や文字列中の一致も含む。
  if (/\b(?:give|clear|item)\b[^\n]*\b(?:minecraft:)?[a-z_]+\s*\{/.test(row.cmd)) markers.itemBraces++;
  if (/\b(?:give|clear|item)\b[^\n]*\b(?:minecraft:)?[a-z_]+\s*\[/.test(row.cmd)) markers.itemComponents++;
  if (/(?:^|[.\s])tag(?:[.\[\s]|$)/.test(row.cmd)) markers.tagPath++;
  if (/(?:^|[.\s])components(?:[.\[\s]|$)/.test(row.cmd)) markers.componentsPath++;
  if (/\b(?:tellraw|title|bossbar|team)\b/.test(row.cmd)) markers.textCommand++;
}
console.log(JSON.stringify({ shapes: { old: old.size, newer: newer.size, common, oldOnly: old.size - common, newOnly: newer.size - common }, total, statuses, parsedMarkers, markers }, null, 2));
