// Aggregate only; never print source commands, names, or map identifiers.
// Usage: node tools/probe-macro-corpus.ts <commands.jsonl> <commands.json>
// A successful probe demonstrates one substitution only, not a fixed command shape.
import { readFileSync } from "node:fs";
import { CommandParser, probeMacroTemplate, type CommandTreeNode } from "@je2be/core";

const [input, grammar] = process.argv.slice(2);
if (!input || !grammar) throw new Error("usage: node tools/probe-macro-corpus.ts <commands.jsonl> <commands.json>");
const parser = new CommandParser(JSON.parse(readFileSync(grammar, "utf8")) as CommandTreeNode, { textFormat: "snbt" });
const counts: Record<string, number> = {};
let total = 0, matched = 0, commandHole = 0, holes = 0, whitespaceExample = 0, differingShapes = 0, fixedSay = 0;
let whitespaceWitnessHoles = 0, whitespaceWitnessLines = 0, unresolvedNoParse = 0, unresolvedOneShape = 0;
const say = parser.root.children?.say;
const sayChildren = Object.entries(say?.children ?? {});
const safeSay = say?.type === "literal" && sayChildren.length === 1 && sayChildren[0]?.[0] === "message" && sayChildren[0]?.[1].parser === "minecraft:message" && sayChildren[0]?.[1].executable === true;
for (const line of readFileSync(input, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as { cmd: string };
  const cmd = row.cmd.trim();
  if (!cmd.startsWith("$")) continue;
  total++;
  holes += [...cmd.matchAll(/\$\(([^()]+)\)/g)].length;
  if (/^\$\$\(/.test(cmd)) commandHole++;
  // A fixed non-space message prefix forces the sole greedy argument to exist.
  // This is a proof about this parser's node sequence, not Java validation or rewriting.
  const fixed = safeSay && /^\$say [^ $]/.test(cmd) && cmd.includes("$(");
  if (fixed) fixedSay++;
  // Two successful parses with different node sequences disprove a fixed shape.
  // Failure to find such a pair does not prove one: the value domain is infinite.
  const shapes = new Set<string>();
  const values = ["0", "x", "minecraft:stone", "@s", "0 0 0", "{}", "1", "true", "false", "~", "run say x"];
  const names = [...new Set([...cmd.matchAll(/\$\(([^()]+)\)/g)].map(m => m[1]!))];
  for (const baseline of values) for (const name of [undefined, ...names]) for (const value of name === undefined ? [baseline] : values) {
    const parsed = parser.parse(cmd.slice(1).replace(/\$\(([^()]+)\)/g, (_match, key: string) => key === name ? value : baseline));
    if (parsed.ok) shapes.add(JSON.stringify(parsed.nodes.map(({ kind, name, parser, jump }) => [kind, name, parser, jump])));
  }
  if (fixed && shapes.size > 1) throw new Error("fixed-shape invariant failed");
  if (shapes.size > 1) differingShapes++;
  else if (!fixed) {
    if (shapes.size === 0) unresolvedNoParse++;
    else unresolvedOneShape++;
  }
  // Compare successful parses while changing only one parameter, from a
  // single token to a value containing spaces. Repeated names change together;
  // count their occurrences, not independent parameters.
  let witnessed = 0;
  for (const name of names) {
    let changed = false;
    for (const baseline of values.filter(v => !v.includes(" "))) {
      const parse = (value: string) => parser.parse(cmd.slice(1).replace(/\$\(([^()]+)\)/g, (_m, key: string) => key === name ? value : baseline));
      const before = parse(baseline);
      if (!before.ok) continue;
      const signature = (nodes: typeof before.nodes) => JSON.stringify(nodes.map(({ kind, name, parser, jump }) => [kind, name, parser, jump]));
      for (const value of ["0 0 0", "run say x"]) {
        const after = parse(value);
        if (after.ok && signature(before.nodes) !== signature(after.nodes)) changed = true;
      }
    }
    if (changed) witnessed += [...cmd.matchAll(/\$\(([^()]+)\)/g)].filter(m => m[1] === name).length;
  }
  whitespaceWitnessHoles += witnessed;
  if (witnessed) whitespaceWitnessLines++;
  // This only establishes an example where all holes can contain spaces; it
  // does not determine whether the number of arguments changes.
  if (parser.parse(cmd.slice(1).replace(/\$\(([^()]+)\)/g, "0 0 0")).ok) whitespaceExample++;
  const result = ["0", "x", "minecraft:stone", "@s", "0 0 0", "{}"].map(value => probeMacroTemplate(parser, cmd, value)).find(Boolean);
  if (!result) continue;
  matched++;
  for (const hole of result.holes) counts[hole.parser] = (counts[hole.parser] ?? 0) + 1;
}
console.log(JSON.stringify({ total, holes, commandHole, matched, unmatched: total - matched, whitespaceExample, whitespaceWitnessHoles, whitespaceWitnessLines, fixedSay, differingShapes, shapeUnresolved: total - differingShapes - fixedSay, unresolvedNoParse, unresolvedOneShape, holeTypesForFirstSuccessfulProbe: counts }, null, 2));
