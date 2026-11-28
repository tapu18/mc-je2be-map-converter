import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { selectCommandGrammar, type MappingTables } from "@je2be/core";
import { writeWorldZip } from "./zip.ts";
import { convertWorld } from "./convert.ts";
import { GEYSER_SOURCE } from "./geyser-source.ts";
import { collectWarnings, describeScope, renderMarkdownReport, type ReportContext } from "./convert-report.ts";
import { fixedJavaDataVersion, loadJavaGrammars } from "./java-grammars.ts";
import { JavaWorld } from "./java-world.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const inside = (parent: string, child: string): boolean => { const r = relative(parent, child); return r === "" || (!r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r)); };

/** 出力親は既存に限定し、シンボリックリンク経由で入力内へ書く場合も拒否する。 */
export function checkedOutputPaths(input: string, output: string, report?: string) {
  const source = realpathSync(input);
  const canonical = (path: string): string => join(realpathSync(dirname(resolve(path))), basename(path));
  const target = canonical(output);
  const reportPath = canonical(report ?? `${target}.report.json`);
  const markdownPath = reportPath.toLowerCase().endsWith(".json") ? `${reportPath.slice(0, -5)}.md` : `${reportPath}.md`;
  for (const path of [target, reportPath, markdownPath]) {
    if (existsSync(path)) throw new Error(`出力が既にあります: ${path}`);
    if (inside(source, path) || inside(path, source)) throw new Error("出力・レポートは入力ワールドと重ならない場所に指定してください");
  }
  for (const path of [reportPath, markdownPath]) if (target === path || inside(target, path) || inside(path, target)) throw new Error("出力とレポートのパスが重なっています");
  return { source, target, reportPath, markdownPath };
}

/** 変換器の版。リポジトリのコミットで示す。 */
function converterVersion(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return `git ${commit}${dirty ? "（未コミットの変更あり）" : ""}`;
  } catch { return "不明（git のコミットを取得できない）"; }
}

export function packageMcworld(world: string, output: string): void {
  if (existsSync(output)) throw new Error("archive output exists");
  writeWorldZip(world, output);
}

/** CLI用。原本をコピーして変換し、レポートと新規の出力だけを作る。 */
export function convertOutput(input: string, output: string, flags: Record<string, string> = {}) {
  const { source, target, reportPath, markdownPath } = checkedOutputPaths(input, output, flags.report);
  const config = JSON.parse(readFileSync(join(root, "tools", "servers.json"), "utf8")) as { java: { version: string }; chunker: { version: string } };
  const dataVersion = new JavaWorld(source).dataVersion();
  let commands = flags.commands;
  if (!commands) {
    const selected = selectCommandGrammar(loadJavaGrammars(), { ...(dataVersion === undefined ? {} : { dataVersion }) });
    if (!selected.ok) throw new Error(`対象ワールドの版別文法がありません（${selected.reason}）。npm run setup:grammars を実行してください`);
    commands = selected.grammar.commandsPath;
  }
  const java = flags.java ?? join(root, "servers", "jre", "bin", "java");
  const chunkerJar = flags.chunker ?? join(root, "servers", "tools", `chunker-cli-${config.chunker.version}.jar`);
  const blocks = flags.blocks ?? join(root, "servers", `reports-${config.java.version}`, "reports", "blocks.json");
  const mappings = flags.mappings ?? join(root, "servers", "mappings", "mappings.json");
  const licenses = ["LICENSE.geyser.txt", "NOTICE.txt"].map(name => join(dirname(mappings), name));
  for (const file of [java, chunkerJar, commands, blocks, mappings, ...licenses]) if (!existsSync(file)) throw new Error(`必要な資材がありません: ${file}。setup:servers / setup:mappings / setup:grammars を確認してください`);
  const mappingData = JSON.parse(readFileSync(mappings, "utf8")) as MappingTables;
  if (mappingData.source.repository !== GEYSER_SOURCE.repository || mappingData.source.revision !== GEYSER_SOURCE.revision) throw new Error("CLIは承認済み固定Geyser対応表を使用してください");
  const work = mkdtempSync(join(dirname(target), ".je2be-output-"));
  let ownsTarget = false;
  let ownsReport = false;
  let ownsMarkdown = false;
  try {
    const stagedInput = join(work, "java");
    cpSync(source, stagedInput, { recursive: true, dereference: true });
    const world = join(work, "bedrock");
    const report = convertWorld(stagedInput, world, { java, chunkerJar, rewrite: { commandsJson: commands, blocksJson: blocks, mappingsJson: mappings } });
    // ID対応の出典とMIT表示を、ワールドと生成パックの両方に置く。
    for (const dir of [world, join(world, "behavior_packs", "je2be_init")]) {
      copyFileSync(licenses[0]!, join(dir, "LICENSE.geyser.txt"));
      copyFileSync(licenses[1]!, join(dir, "NOTICE.geyser.txt"));
    }
    const context: ReportContext = { ...(dataVersion === undefined ? {} : { dataVersion }), converterVersion: converterVersion(),
      chunkerVersion: config.chunker.version, mappingJavaVersion: config.java.version, mappingDataVersion: fixedJavaDataVersion };
    const warnings = collectWarnings(report);
    const scope = describeScope(report, context);
    const fullReport = { schemaVersion: 1, status: "partial", input: source, output: target, markdown: markdownPath, dataVersion,
      converterVersion: context.converterVersion, clientVerification: "not-performed", clearConfirmed: false,
      processed: scope.processed, limitations: scope.notChecked, ...report, warnings };
    writeFileSync(reportPath, JSON.stringify(fullReport, null, 2) + "\n", { flag: "wx" });
    ownsReport = true;
    writeFileSync(markdownPath, renderMarkdownReport(report, warnings, context), { flag: "wx" });
    ownsMarkdown = true;
    if (target.toLowerCase().endsWith(".mcworld")) {
      const archive = join(work, "output.mcworld");
      packageMcworld(world, archive);
      linkSync(archive, target); // 同じファイルシステム。既存ファイルへは上書きしない。
      ownsTarget = true;
    } else {
      mkdirSync(target); // 既存ディレクトリも拒否する。作った空のディレクトリへ中身を移す。
      ownsTarget = true;
      for (const name of readdirSync(world)) renameSync(join(world, name), join(target, name));
    }
    return { output: target, report: reportPath, markdown: markdownPath, status: fullReport.status, clientVerification: fullReport.clientVerification, clearConfirmed: false,
      scores: report.scores, storage: report.storage, entities: report.entities, datapacks: report.datapacks, commands: report.commands?.counts, limitations: fullReport.limitations };
  } catch (error) {
    if (ownsTarget) rmSync(target, { recursive: true, force: true });
    if (ownsReport) rmSync(reportPath, { force: true });
    if (ownsMarkdown) rmSync(markdownPath, { force: true });
    throw error;
  } finally { rmSync(work, { recursive: true, force: true }); }
}
