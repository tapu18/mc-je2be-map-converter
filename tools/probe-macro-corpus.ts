// Aggregate only; never print source commands, names, or map identifiers.
// Usage: node tools/probe-macro-corpus.ts <commands.jsonl> <commands.json>
// A successful probe demonstrates one substitution only, not a fixed command shape.
import { readFileSync } from "node:fs";
import { CommandParser, probeMacroTemplate, type CommandTreeNode } from "@je2be/core";

const [input, grammar] = process.argv.slice(2);
if (!input || !grammar) throw new Error("usage: node tools/probe-macro-corpus.ts <commands.jsonl> <commands.json>");
const parser = new CommandParser(JSON.parse(readFileSync(grammar, "utf8")) as CommandTreeNode, { textFormat: "snbt" });
const counts: Record<string, number> = {};
let total = 0, matched = 0, commandHole = 0, holes = 0, whitespaceExample = 0;
for (const line of readFileSync(input, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as { cmd: string };
  const cmd = row.cmd.trim();
  if (!cmd.startsWith("$")) continue;
  total++;
  holes += [...cmd.matchAll(/\$\(([^()]+)\)/g)].length;
  if (/^\$\$\(/.test(cmd)) commandHole++;
  // This only establishes an example where all holes can contain spaces; it
  // does not determine whether the number of arguments changes.
  if (parser.parse(cmd.slice(1).replace(/\$\(([^()]+)\)/g, "0 0 0")).ok) whitespaceExample++;
  const result = ["0", "x", "minecraft:stone", "@s", "0 0 0", "{}"].map(value => probeMacroTemplate(parser, cmd, value)).find(Boolean);
  if (!result) continue;
  matched++;
  for (const hole of result.holes) counts[hole.parser] = (counts[hole.parser] ?? 0) + 1;
}
console.log(JSON.stringify({ total, holes, commandHole, matched, unmatched: total - matched, whitespaceExample, holeTypesForFirstSuccessfulProbe: counts }, null, 2));
