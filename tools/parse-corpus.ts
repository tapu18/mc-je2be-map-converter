// 配布マップのコマンドのパース成功率を集計する（#13）。
// 使い方:
//   python3 -I scripts/dump_commands.py sample-map > <scratch>/commands.jsonl
//   node tools/parse-corpus.ts <scratch>/commands.jsonl [--commands <commands.json>] [--failures <出力先>] [--java]
//
// --java を付けると、重複を除いたコマンドを Java 版サーバー（tools/servers.json の版）にも読ませ、
// パーサの判定と突き合わせる（packages/bridge/src/java-syntax.ts。数分かかる）。
//
// 出力は件数と失敗の分類だけ（コマンドの文面は出さない）。--failures を付けると、失敗したコマンドの文面を
// 指定のファイルに書く（調べるため。権利上リポジトリに入れないこと）。
// マクロ行（`$` で始まる）は実行時に文字列が決まるため、パースせずに数だけ数える。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkJavaSyntax, paths } from "@je2be/bridge";
import { CommandParser, textFormatFor, type CommandTreeNode } from "@je2be/core";

interface Row {
  map: number;
  dataVersion: number | null;
  packFormat: number | null;
  source: "cb" | "fn";
  cmd: string;
}

const args = process.argv.slice(2);
const input = args[0];
if (!input) {
  console.error("usage: node tools/parse-corpus.ts <commands.jsonl> [--commands <commands.json>] [--failures <file>]");
  process.exit(2);
}
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const treePath = flag("--commands") ?? join(paths.blocksReport, "..", "commands.json");
const tree = JSON.parse(readFileSync(treePath, "utf8")) as CommandTreeNode;
const parsers = { json: new CommandParser(tree, { textFormat: "json" }), snbt: new CommandParser(tree, { textFormat: "snbt" }) };

const rows = readFileSync(input, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

interface Tally {
  total: number;
  macro: number;
  ok: number;
}
const tally = (): Tally => ({ total: 0, macro: 0, ok: 0 });
const bySource: Record<string, Tally> = {};
const byVersion: Record<string, Tally> = {};
const byMap: Record<string, Tally> = {};
const failureReasons: Record<string, number> = {};
const failureHeads: Record<string, number> = {};
const failures: string[] = [];
/** パーサの判定（重複を除いたコマンド → 成否と失敗理由） */
const verdicts = new Map<string, { ok: boolean; reason?: string }>();

for (const row of rows) {
  const keys = [
    [bySource, row.source],
    [byVersion, String(row.dataVersion ?? "不明")],
    [byMap, String(row.map)],
  ] as const;
  for (const [t, k] of keys) t[k] ??= tally();
  const bump = (f: keyof Tally): void => {
    for (const [t, k] of keys) (t[k] as Tally)[f]++;
  };
  bump("total");
  const cmd = row.cmd.trim();
  if (cmd.startsWith("$")) {
    bump("macro");
    continue;
  }
  const result = parsers[textFormatFor(row.dataVersion ?? undefined)].parse(cmd);
  verdicts.set(cmd.replace(/^\//, ""), result.ok ? { ok: true } : { ok: false, reason: `${result.error.parser ?? "(リテラル)"}: ${result.error.message}` });
  if (result.ok) {
    bump("ok");
    continue;
  }
  // 先頭の語は、文法にあるコマンド名だけを出す（コマンドブロックに文章が書かれていることがあるため）
  const word = cmd.replace(/^\//, "").split(" ")[0] ?? "";
  const head = tree.children?.[word] ? word : "(文法にない語)";
  const reason = `${result.error.parser ?? "(リテラル)"}: ${result.error.message.replace(/'[^']*'/g, "'…'").replace(/（[^）]*）/g, "")}`;
  failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
  failureHeads[head] = (failureHeads[head] ?? 0) + 1;
  failures.push(`${row.map}\t${row.dataVersion}\t${row.source}\t${result.error.position}\t${result.error.parser ?? ""}\t${result.error.message}\t${cmd}`);
}

const rate = (t: Tally): string => {
  const parsed = t.total - t.macro;
  return parsed ? `${((t.ok / parsed) * 100).toFixed(1)}%` : "-";
};
const table = (title: string, data: Record<string, Tally>): void => {
  console.log(`\n### ${title}\n\n| 区分 | 行数 | マクロ | パース対象 | 成功 | 成功率 |\n| --- | ---: | ---: | ---: | ---: | ---: |`);
  for (const [k, t] of Object.entries(data).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
    console.log(`| ${k} | ${t.total} | ${t.macro} | ${t.total - t.macro} | ${t.ok} | ${rate(t)} |`);
  }
};
const top = (title: string, data: Record<string, number>, n = 25): void => {
  console.log(`\n### ${title}\n\n| 件数 | 内容 |\n| ---: | --- |`);
  for (const [k, v] of Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, n)) console.log(`| ${v} | \`${k}\` |`);
};

const all = rows.reduce((t, r) => t, tally());
for (const t of Object.values(bySource)) {
  all.total += t.total;
  all.macro += t.macro;
  all.ok += t.ok;
}
console.log(`文法: ${treePath}\n全体: ${all.total}行（マクロ ${all.macro}）、パース対象 ${all.total - all.macro}、成功 ${all.ok}（${rate(all)}）`);
table("コマンドの出どころ別（cb=コマンドブロック、fn=関数）", bySource);
table("ワールドの DataVersion 別", byVersion);
table("マップ別（連番）", byMap);
top("失敗の理由（引数の型: 内容）", failureReasons);
top("失敗したコマンドの先頭の語", failureHeads);
/**
 * Java のエラー文を分類する。作者が付けた ID（独自の名前空間の関数・述語など）は出さず、
 * バニラのレジストリ名やコンポーネント名だけを残す
 */
const classifyJavaError = (m: string): string => {
  let x: RegExpExecArray | null;
  if ((x = /Can't find element '([^']*)' (?:of type|in registry) 'minecraft:([a-z_/]+)'/.exec(m))) {
    return x[1]?.startsWith("minecraft:") ? `レジストリにない ID（${x[2]}）` : `データパック内の定義を参照（${x[2]}）`;
  }
  if ((x = /Unknown (block|item|entity_type|function) tag '([^']*)'/.exec(m))) {
    return x[2]?.startsWith("minecraft:") ? `バニラにないタグ（${x[1]}）` : `データパック内のタグを参照（${x[1]}）`;
  }
  if ((x = /Malformed '(minecraft:[a-z_]+)' component/.exec(m))) return `コンポーネントの値の形（${x[1]}）`;
  if (/^Can't parse particle options/.test(m)) return "パーティクルのオプションの形";
  if (/^Failed to parse structure/.test(m)) return "その場で書いた定義の形（述語・アイテム修飾子など）";
  if (/^Unknown (particle|block type|item|entity)/.test(m)) return `レジストリにない ID（${/^Unknown (\w+( type)?)/.exec(m)?.[1]}）`;
  return m.replace(/'[^']*'/g, "'…'").replace(/ at position \d+.*$/, "").replace(/\d+/g, "N");
};
const abstractMessage = (m: string): string => m.replace(/'[^']*'/g, "'…'").replace(/（[^）]*）/g, "").replace(/ at position \d+.*$/, "").replace(/\d+/g, "N");

if (args.includes("--java")) {
  const unique = [...verdicts.keys()];
  const java = await checkJavaSyntax(unique);
  const matrix = { bothOk: 0, bothFail: 0, parserOnlyOk: 0, javaOnlyOk: 0 };
  const parserOnlyOk: Record<string, number> = {};
  const javaOnlyOk: Record<string, number> = {};
  const lines: string[] = [];
  for (const j of java) {
    const p = verdicts.get(j.command) as { ok: boolean; reason?: string };
    if (p.ok && j.ok) matrix.bothOk++;
    else if (!p.ok && !j.ok) matrix.bothFail++;
    else if (p.ok) {
      matrix.parserOnlyOk++;
      const k = classifyJavaError(j.error ?? "");
      parserOnlyOk[k] = (parserOnlyOk[k] ?? 0) + 1;
      lines.push(`parser-ok\t${j.error}\t${j.command}`);
    } else {
      matrix.javaOnlyOk++;
      const k = abstractMessage(p.reason ?? "");
      javaOnlyOk[k] = (javaOnlyOk[k] ?? 0) + 1;
      lines.push(`java-ok\t${p.reason}\t${j.command}`);
    }
  }
  console.log(`\n### Java 版サーバーとの突き合わせ（重複を除いた ${unique.length} 件、マクロ行を除く）\n`);
  console.log(`| パーサ \\ Java | 読める | 読めない |\n| --- | ---: | ---: |`);
  console.log(`| 読める | ${matrix.bothOk} | ${matrix.parserOnlyOk} |\n| 読めない | ${matrix.javaOnlyOk} | ${matrix.bothFail} |`);
  top("パーサだけが読めたもの（Java のエラー）", parserOnlyOk);
  top("Java だけが読めたもの（パーサのエラー）", javaOnlyOk);
  const mismatch = flag("--mismatches");
  if (mismatch) writeFileSync(mismatch, lines.join("\n") + "\n");
}

const out = flag("--failures");
if (out) writeFileSync(out, failures.join("\n") + "\n");
