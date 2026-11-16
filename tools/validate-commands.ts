// 対象 Java で読めないコマンドを追加検証レポートにする。入力は dump_commands.py と同じ JSONL。
// --datapack は展開済みディレクトリを指定する。元パックは変更せず、コピーの関数は空にする。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inspectJavaSyntax, paths } from "@je2be/bridge";
import { buildJavaValidationReport, javaValidationSkipReason, type ValidationCommand } from "@je2be/converter";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  datapack: { type: "string", multiple: true }, out: { type: "string" },
} });
if (positionals.length !== 1) throw new Error("usage: node tools/validate-commands.ts <commands.jsonl> [--datapack <directory> ...] [--out <report.json>]");
const commands: ValidationCommand[] = readFileSync(positionals[0]!, "utf8").split("\n").flatMap((line, i) => {
  if (!line.trim()) return [];
  const row = JSON.parse(line) as { id?: unknown; cmd?: unknown };
  if (typeof row.cmd !== "string") throw new Error(`expected cmd string on JSONL line ${i + 1}`);
  if (row.id !== undefined && typeof row.id !== "string") throw new Error(`expected id string on JSONL line ${i + 1}`);
  return [{ id: row.id as string | undefined ?? `line:${i + 1}`, command: row.cmd }];
});
const datapacks = (values.datapack ?? []).map((path) => resolve(path));
const eligible = commands.filter((c) => !javaValidationSkipReason(c.command));
const batch = await inspectJavaSyntax(eligible.map((c) => c.command), { datapacks });
const config = JSON.parse(readFileSync(join(paths.servers, "..", "tools", "servers.json"), "utf8")) as { java: { version: string } };
const report = buildJavaValidationReport(commands, batch, { javaVersion: config.java.version, datapacks });
const output = resolve(values.out ?? join(paths.servers, "command-validation.json"));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
// stdout は件数だけ。詳細には作者の ID や Java のエラー文が含まれるので公開しない。
console.log(JSON.stringify({ output, javaVersion: report.javaVersion, complete: report.complete, summary: report.summary }, null, 2));
if (!batch.checked || report.summary.invalid || report.summary.unresolvedReferences || report.summary.contextErrors) process.exitCode = 1;
