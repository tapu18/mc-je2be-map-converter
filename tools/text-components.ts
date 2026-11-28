// tellraw・title のテキスト成分を、コーパスの非公開入力から数える（#347）。
// 出力は集計値だけ（行数・作品数）。コマンドの文面・作品名・翻訳キー・ID は出さない。
// 手順は docs/text-components.md。
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { profileText, rewriteCommand, rewriteSelectorString, textCommandPlan, textFormatFor, textKinds, textStyles, toCommandIR, toRawText, type RewriteContext } from "@je2be/core";
import { loadJavaGrammars, loadRewriteContext } from "@je2be/converter";
import { corpusContext, type CorpusVersion } from "./corpus-grammar.ts";

const { values } = parseArgs({ options: { commands: { type: "string" } } });
if (!values.commands) throw new Error("Usage: node tools/text-components.ts --commands PRIVATE.jsonl > text-components.md");

type CommandLine = CorpusVersion & { map: number; source: "cb" | "fn"; cmd: string };
type Count = { lines: number; maps: Set<number> };
type Tally = Map<string, Count>;

const root = fileURLToPath(new URL("../", import.meta.url));
const versions = JSON.parse(readFileSync(join(root, "tools/servers.json"), "utf8")) as { java: { version: string; dataVersion: number }; bedrock: { version: string } };
const reports = join(root, "servers", `reports-${versions.java.version}`, "reports");
const base = loadRewriteContext({
  commandsJson: join(reports, "commands.json"), blocksJson: join(reports, "blocks.json"), mappingsJson: join(root, "servers/mappings/mappings.json"),
}, textFormatFor(versions.java.dataVersion));
const grammars = loadJavaGrammars();
if (!grammars.length) throw new Error("Run npm run setup:grammars first");
const contexts = new Map<string, RewriteContext>();

const tallies = { shape: new Map(), kind: new Map(), kindOutput: new Map(), style: new Map(), depth: new Map(), issue: new Map(), nbtSource: new Map(), outcome: new Map(), lineIssue: new Map() } satisfies Record<string, Tally>;
const bump = (tally: Tally, key: string, map: number) => {
  const c = tally.get(key) ?? { lines: 0, maps: new Set<number>() };
  c.lines++;
  c.maps.add(map);
  tally.set(key, c);
};
const totals = { lines: 0, skipped: 0 };

/** 問題の文を、文面や ID を含まない分類名にする */
const knownKeys = new Set(["click_event", "clickEvent", "hover_event", "hoverEvent", "insertion", "font", "shadow_color", "separator"]);
function bucket(message: string): string {
  return message
    .replace(/'([^']*)'/g, (all, key: string) => (knownKeys.has(key) ? all : "'…'"))
    .replace(/#[0-9a-fA-F]{6}/g, "#…")
    .replace(/type=#[^）)]*/g, "type=#…")
    .replace(/[a-z0-9_.-]+:[a-z0-9_./-]+/g, "<ID>")
    .replace(/(読めない|セレクタ): .*$/, "$1: …")
    .replace(/（\d+–\d+文字目）/g, "");
}

const reader = createInterface({ input: createReadStream(values.commands), crlfDelay: Infinity });
try {
  for await (const line of reader) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CommandLine;
    const text = row.cmd.trim();
    if (text.startsWith("$") || !/\b(tellraw|title)\b/.test(text)) continue;
    const chosen = corpusContext(row, text, grammars, base, contexts);
    const context = chosen.context;
    if (!context || chosen.different) { if (/^(execute .* run )?(tellraw|title) /.test(text)) totals.skipped++; continue; }
    const parsed = context.parser.parse(text);
    if (!parsed.ok) continue;
    const plan = textCommandPlan(toCommandIR(text, parsed.nodes));
    if (!plan || plan.text.value?.kind !== "text") continue;
    totals.lines++;
    const value = plan.text.value.value;
    bump(tallies.shape, plan.display ? `title … ${plan.display}` : "tellraw", row.map);
    const profile = profileText(value);
    const raw = toRawText(value, { selector: rewriteSelectorString });
    const textOutput = !raw.issues.some(i => i.severity === "unsupported");
    for (const kind of profile.kinds) {
      bump(tallies.kind, kind, row.map);
      if (textOutput) bump(tallies.kindOutput, kind, row.map);
    }
    for (const style of profile.styles) bump(tallies.style, style, row.map);
    for (const source of profile.nbtSources) bump(tallies.nbtSource, source, row.map);
    bump(tallies.depth, profile.extraDepth >= 4 ? "4+" : String(profile.extraDepth), row.map);
    for (const issue of new Set(raw.issues.map(i => `${i.severity}: ${bucket(i.message)}`))) bump(tallies.issue, issue, row.map);
    const whole = rewriteCommand(text, context);
    bump(tallies.outcome, `text ${textOutput ? "output" : "unsupported"} / line ${whole.status}`, row.map);
    if (textOutput && whole.status === "unsupported") {
      const own = new Set(raw.issues.map(i => i.message));
      for (const reason of new Set(whole.issues.filter(i => i.severity === "unsupported" && !own.has(i.message)).map(i => bucket(i.message)))) bump(tallies.lineIssue, reason, row.map);
    }
  }
} catch {
  // 例外の文には、コマンドの文面が入り得る
  throw new Error("Could not count text components. Check the private input locally.");
} finally {
  reader.close();
}

const maps = new Set<number>();
for (const c of tallies.shape.values()) for (const m of c.maps) maps.add(m);
const table = (title: string, header: string, tally: Tally, order?: readonly string[], extra?: (key: string) => string) => {
  const keys = order ? order.filter(k => tally.has(k)) : [...tally.keys()].sort((a, b) => tally.get(b)!.lines - tally.get(a)!.lines || a.localeCompare(b));
  const out = [`### ${title}`, "", `| ${header} | 行数 | 作品数 |${extra ? " rawtext に出せた行 |" : ""}`, `| --- | ---: | ---: |${extra ? " ---: |" : ""}`];
  for (const k of keys) out.push(`| \`${k.replaceAll("|", "\\|")}\` | ${tally.get(k)!.lines} | ${tally.get(k)!.maps.size} |${extra ? ` ${extra(k)} |` : ""}`);
  return out.join("\n");
};
console.log([
  `対象：パースでき、テキストを持つ \`tellraw\`・\`title\`（\`execute … run\` の末尾を含む）${totals.lines} 行・${maps.size} 作品。版が選べない・版で結果が異なる行 ${totals.skipped} 行は除いた。`,
  "1行に複数の種類・書式があれば、それぞれに1回数える。",
  "",
  table("コマンドの形", "形", tallies.shape),
  "",
  table("成分の種類", "種類", tallies.kind, textKinds, k => String(tallies.kindOutput.get(k)?.lines ?? 0)),
  "",
  table("書式・付属のキー", "キー", tallies.style, textStyles),
  "",
  table("extra の深さ", "深さ", tallies.depth, ["0", "1", "2", "3", "4+"]),
  "",
  table("nbt 成分の読み先", "読み先", tallies.nbtSource, ["storage", "entity", "block"]),
  "",
  table("rawtext への書き換えの結果（テキスト単体／行全体）", "結果", tallies.outcome),
  "",
  table("テキストの書き換えの問題（文面と ID を伏せた分類）", "分類", tallies.issue),
  "",
  table("テキストは出せたが行全体が unsupported になった理由（テキスト以外）", "理由", tallies.lineIssue),
].join("\n"));
