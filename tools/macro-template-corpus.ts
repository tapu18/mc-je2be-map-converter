// 配布マップのマクロ行を #316 の型紙（compileMacroTemplate）に通し、成功と診断の理由を数える（#349）。
// 使い方:
//   python3 -I scripts/dump_commands.py sample-map > <scratch>/commands.jsonl
//   node tools/macro-template-corpus.ts <scratch>/commands.jsonl [--grammars <servers/grammars>] [--bench]
//
// 文法はデータパック変換（packages/converter/src/datapacks.ts）と同じく pack_format の範囲で選ぶ。
// 出力は件数・作品数（作品は連番の個数だけ）と、値・名前を伏せた形だけ。コマンドの文面は出さない。
// 形は文法の節の列から作る（リテラルは文法の語、引数は型名、穴を含む引数は <型:$>）。
// --bench を付けると、型紙になった行の穴を埋める処理（expandMacro）の時間を測る。
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import {
  CommandParser, commandGrammarCandidates, compileMacroTemplate, deserializeCommandIR, normalizeCommandIR, selectCommandGrammar,
  serializeCommandIR, type CommandIR, type PackFormatRange,
} from "@je2be/core";
import { grammarRoot, loadGrammarTree, loadJavaGrammars, type JavaGrammarInstallation } from "@je2be/converter";
import { expandMacro } from "../packages/core/src/command/macro-arguments.ts";
import type { NbtCompound, NbtTag } from "../packages/core/src/nbt/nbt.ts";

interface Row {
  map: number;
  dataVersion: number | null;
  packFormat?: number | null;
  packFormatRange?: PackFormatRange | null;
  source: "cb" | "fn";
  cmd: string;
}

const args = process.argv.slice(2);
const input = args[0];
if (!input) throw new Error("usage: node tools/macro-template-corpus.ts <commands.jsonl> [--grammars <dir>] [--bench]");
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const grammars = loadJavaGrammars(flag("--grammars") ?? grammarRoot);
if (!grammars.length) throw new Error("版別文法がない。npm run setup:grammars を実行するか --grammars で指定する");
const parsers = new Map<string, CommandParser>();
const parserFor = (grammar: JavaGrammarInstallation): CommandParser => {
  let parser = parsers.get(grammar.version);
  if (!parser) parsers.set(grammar.version, parser = new CommandParser(loadGrammarTree(grammar), grammar));
  return parser;
};

/** 理由の文から値を伏せる（理由の文は変換器が作るが、念のため引用部分を落とす） */
const abstractReason = (reason: string): string => reason.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, "\"…\"");

const holePattern = /\$\(([^)]*)\)/g;
const samples = ["0", "1", "x", "@s", "0 0 0", "{}", "minecraft:stone", "run say x"];
/** 値を伏せた形。穴を一つの値で埋めてパースできた最初の例から、節の列を作る */
const maskedShape = (parser: CommandParser, cmd: string): string => {
  for (const sample of samples) {
    let concrete = "";
    let cursor = 1;
    const spans: [number, number][] = [];
    for (const match of cmd.matchAll(holePattern)) {
      concrete += cmd.slice(cursor, match.index);
      spans.push([concrete.length, concrete.length + sample.length]);
      concrete += sample;
      cursor = match.index + match[0].length;
    }
    concrete += cmd.slice(cursor);
    const parsed = parser.parse(concrete);
    if (!parsed.ok) continue;
    const words = parsed.nodes.map(node => {
      const hole = spans.some(([start, end]) => start < node.end && node.start < end);
      const crossing = spans.some(([start, end]) => start < node.end && node.start < end && !(node.start <= start && end <= node.end));
      if (node.kind === "literal") return hole ? `${node.name}:$` : node.name;
      const type = (node.parser ?? "?").replace(/^(minecraft|brigadier):/, "");
      return `<${type}${hole ? crossing ? ":$跨" : ":$" : ""}>`;
    });
    // 穴が節の外（空白など）にかかる場合も印を付ける
    const outside = spans.some(([start, end]) => !parsed.nodes.some(node => start < node.end && node.start < end));
    return words.join(" ") + (outside ? " (穴が節の外)" : "");
  }
  const word = cmd.slice(1).split(" ")[0] ?? "";
  return `(どの値でもパースできない) 先頭: ${word.includes("$(") ? "$" : parser.root.children?.[word] ? word : "(文法にない語)"}`;
};

type Outcome = { ok: true; ir: CommandIR; version: string; textFormat: "snbt" | "json"; parser: CommandParser } | { ok: false; reason: string; shape?: string };
const rows = readFileSync(input, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Row);
const total = { lines: 0, maps: new Set<number>(), bySource: {} as Record<string, number> };
const byReason = new Map<string, { lines: number; maps: Set<number>; shapes: Map<string, { lines: number; maps: Set<number> }> }>();
const okMaps = new Set<number>();
const byMap = new Map<number, { lines: number; ok: number }>();
const templates: { ir: CommandIR; parser: CommandParser }[] = [];
let ok = 0;

const compile = (row: Row, cmd: string): Outcome => {
  if (row.source !== "fn") return { ok: false, reason: "コマンドブロックの $ 行（マクロではない）" };
  const source = row.packFormatRange ? { packFormatRange: row.packFormatRange } : {};
  const selected = selectCommandGrammar(grammars, source);
  const candidates = selected.ok ? [selected.grammar] : selected.reason === "ambiguous" ? commandGrammarCandidates(grammars, source) : [];
  if (!candidates.length) return { ok: false, reason: `文法なし（${row.packFormatRange ? selected.ok ? "" : selected.reason : "pack_format 不明"}）` };
  const results = candidates.map(grammar => ({ grammar, result: compileMacroTemplate(parserFor(grammar), cmd, grammar.version) }));
  const first = results[0]!;
  if (results.some(({ result }) => result.ok !== first.result.ok || (!result.ok && !first.result.ok && result.reason !== first.result.reason))) {
    return { ok: false, reason: "範囲内の版で結果が異なる" };
  }
  if (first.result.ok) return { ok: true, ir: first.result.ir, version: first.grammar.version, textFormat: first.grammar.textFormat, parser: parserFor(first.grammar) };
  return { ok: false, reason: abstractReason(first.result.reason), shape: maskedShape(parserFor(first.grammar), cmd) };
};

for (const row of rows) {
  const cmd = row.cmd.trim();
  if (!cmd.startsWith("$")) continue;
  total.lines++;
  total.maps.add(row.map);
  total.bySource[row.source] = (total.bySource[row.source] ?? 0) + 1;
  const map = byMap.get(row.map) ?? { lines: 0, ok: 0 };
  byMap.set(row.map, map);
  map.lines++;
  const outcome = compile(row, cmd);
  if (outcome.ok) {
    ok++;
    map.ok++;
    okMaps.add(row.map);
    // 実行時と同じく、保存形式を通した IR を使う
    const decoded = deserializeCommandIR(serializeCommandIR({ grammarVersion: outcome.version, textFormat: outcome.textFormat, ir: outcome.ir }));
    if (!decoded.ok) throw new Error(`round trip failed: ${decoded.diagnostic}`);
    templates.push({ ir: decoded.document.ir, parser: outcome.parser });
    continue;
  }
  const entry = byReason.get(outcome.reason) ?? { lines: 0, maps: new Set(), shapes: new Map() };
  byReason.set(outcome.reason, entry);
  entry.lines++;
  entry.maps.add(row.map);
  if (outcome.shape) {
    const shape = entry.shapes.get(outcome.shape) ?? { lines: 0, maps: new Set() };
    entry.shapes.set(outcome.shape, shape);
    shape.lines++;
    shape.maps.add(row.map);
  }
}

const percent = (n: number, d: number): string => d ? `${(n / d * 100).toFixed(1)}%` : "-";
console.log(`マクロ行（$ で始まる行）: ${total.lines} 行、${total.maps.size} 作品（出どころ: ${Object.entries(total.bySource).map(([k, v]) => `${k} ${v}`).join("、")}）`);
console.log(`型紙になった行: ${ok} 行（${percent(ok, total.lines)}）、${okMaps.size} 作品`);
console.log(`全行が型紙になった作品: ${[...byMap.values()].filter(m => m.ok === m.lines).length} / ${byMap.size}`);
console.log("\n### 作品別（連番。static-coverage.md の map-N と同じ入力なら同じ番号）\n\n| 作品 | マクロ行 | 型紙 | 割合 |\n| --- | ---: | ---: | ---: |");
for (const [map, m] of [...byMap].sort((a, b) => a[0] - b[0])) console.log(`| map-${map} | ${m.lines} | ${m.ok} | ${percent(m.ok, m.lines)} |`);
console.log("\n### 診断の理由\n\n| 理由 | 行数 | 割合 | 作品数 |\n| --- | ---: | ---: | ---: |");
const reasons = [...byReason].sort((a, b) => b[1].lines - a[1].lines);
for (const [reason, entry] of reasons) console.log(`| ${reason} | ${entry.lines} | ${percent(entry.lines, total.lines)} | ${entry.maps.size} |`);
console.log("\n### 理由ごとの形（値・名前を伏せた節の列。上位8件）");
for (const [reason, entry] of reasons) {
  if (!entry.shapes.size) continue;
  console.log(`\n#### ${reason}（${entry.shapes.size} 形）\n\n| 行数 | 作品数 | 形 |\n| ---: | ---: | --- |`);
  for (const [shape, s] of [...entry.shapes].sort((a, b) => b[1].lines - a[1].lines).slice(0, 8)) {
    console.log(`| ${s.lines} | ${s.maps.size} | \`${shape.length > 160 ? shape.slice(0, 160) + "…" : shape}\` |`);
  }
}

if (args.includes("--bench")) bench();

function bench(): void {
  // 穴に入れる値を型紙ごとに探す。数値・名前・NBT の順に試し、expandMacro が通った値を使う
  const tries: [string, (i: number) => NbtTag][] = [
    ["0", i => ({ type: "int", value: i % 1000 })],
    ["x", i => ({ type: "string", value: `x${i}` })],
    ["{}", i => ({ type: "string", value: `{a:${i}}` })],
    ["@s", () => ({ type: "string", value: "@s" })],
    ["0 0 0", i => ({ type: "string", value: `${i % 100} 0 0` })],
    ["minecraft:stone", () => ({ type: "string", value: "minecraft:stone" })],
  ];
  const argumentsFor = (ir: CommandIR, value: (i: number) => NbtTag, i: number): NbtCompound => {
    const keys = new Set(ir.macro!.arguments.flatMap(a => a.parts.flatMap(p => typeof p === "string" ? [] : [p.key])));
    return { type: "compound", value: new Map([...keys].map(key => [key, value(i)])) };
  };
  const cases: { ir: CommandIR; parser: CommandParser; value: (i: number) => NbtTag; varies: boolean }[] = [];
  let unfilled = 0;
  for (const { ir, parser } of templates) {
    const found = tries.find(([, value]) => expandMacro(ir, argumentsFor(ir, value, 0)).ok && expandMacro(ir, argumentsFor(ir, value, 1)).ok);
    if (found) cases.push({ ir, parser, value: found[1], varies: !["@s", "minecraft:stone"].includes(found[0]) });
    else unfilled++;
  }
  console.log(`\n### 穴を埋める時間（expandMacro、Node ${process.version}）\n`);
  console.log(`対象: 型紙 ${templates.length} 行のうち、試した値で埋められた ${cases.length} 行（値が毎回変わる ${cases.filter(c => c.varies).length} 行）。埋められなかった ${unfilled} 行は除く`);
  const rounds = 20;
  const measure = (label: string, run: (round: number) => void): void => {
    run(-1); // ウォームアップ
    const times: number[] = [];
    for (let round = 0; round < rounds; round++) {
      const start = performance.now();
      run(round);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(rounds / 2)]!;
    console.log(`| ${label} | ${(median / cases.length * 1000).toFixed(2)} µs | ${(times[0]! / cases.length * 1000).toFixed(2)} µs | ${(times[rounds - 1]! / cases.length * 1000).toFixed(2)} µs |`);
  };
  console.log("\n| 条件（全対象行を1周、20周の中央値・最小・最大を1行あたりに換算） | 中央値 | 最小 | 最大 |\n| --- | ---: | ---: | ---: |");
  const fixed = cases.map(c => argumentsFor(c.ir, c.value, 7));
  measure("同じ引数の繰り返し", () => { for (const [i, c] of cases.entries()) if (!expandMacro(c.ir, fixed[i]).ok) throw new Error("expand failed"); });
  measure("毎回違う引数", round => {
    for (const [i, c] of cases.entries()) if (!expandMacro(c.ir, argumentsFor(c.ir, c.value, round * cases.length + i + 1000)).ok) throw new Error("expand failed");
  });
  // キャッシュを入れた場合の当たりの費用（引数を文字列にして Map を引く）。外れの費用は上の展開＋この費用
  const key = (input: NbtCompound): string => JSON.stringify([...input.value].map(([k, v]) => [k, v.type, String(v.value)]));
  const caches = cases.map(() => new Map<string, CommandIR>());
  for (const [i, c] of cases.entries()) caches[i]!.set(key(fixed[i]!), (expandMacro(c.ir, fixed[i]) as { ir: CommandIR }).ir);
  measure("キャッシュ当たり（鍵の生成と Map 参照）", () => { for (const [i, c] of cases.entries()) if (!caches[i]!.get(key(fixed[i]!))) throw new Error("miss"); });
  // 参考: 型紙を使わず、埋めた文字列を毎回文法でパースし直す場合（パース結果の正規化は含めない）
  const sources = cases.map((c, i) => (expandMacro(c.ir, fixed[i]) as { ir: CommandIR }).ir.source);
  // 内訳: expandMacro の最後に行う版の正規化だけ（埋めた IR を正規化し直す）
  const expanded = cases.map((c, i) => { const ir = (expandMacro(c.ir, fixed[i]) as { ir: CommandIR }).ir; delete ir.macro; return { ir, version: c.ir.macro!.version }; });
  measure("内訳: 正規化（normalizeCommandIR）だけ", () => { for (const e of expanded) if (!normalizeCommandIR(e.ir, e.version).ok) throw new Error("normalize failed"); });
  measure("参考: 埋めた文字列を文法でパースし直す", () => { for (const [i, c] of cases.entries()) c.parser.parse(sources[i]!); });
}
