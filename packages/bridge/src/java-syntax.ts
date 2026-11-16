// Java 版サーバーに、コマンドが文法として正しいかを判定させる（#13 のパーサの正解データ）。
// コマンド1つを関数1つにしたデータパックを入れて起動し、読み込みに失敗した関数をログから拾う。
// 関数は読み込み時に全行がパースされ、1行でも失敗すると関数ごと読み込まれない（実測、#13）。
// 実行はしないので、ワールドの状態には影響しない。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { JavaServer } from "./java.ts";
import { copySyntaxDatapack } from "./syntax-datapacks.ts";
import { paths } from "./paths.ts";

export interface JavaSyntaxOptions {
  /** 同時に読むディレクトリまたは ZIP。コピーの関数本文は空にする。 */
  datapacks?: string[];
  /** 元ワールドの有効順。省略時は vanilla → datapacks の指定順。 */
  packOrder?: ({ builtin: string } | { datapack: number })[] | undefined;
}

export interface JavaSyntaxInspection {
  checked: boolean;
  results: JavaSyntaxResult[];
  /** 判定に使ったパックに関する読み込みエラー・未有効化。空でもパック全体の健全性は保証しない。 */
  contextErrors: string[];
  enabledPacks: string;
}

export interface JavaSyntaxResult {
  command: string;
  ok: boolean;
  /** 失敗したときの Java のエラー文 */
  error?: string;
}

/**
 * コマンドの列を Java 版サーバーでパースする。先頭の `/` は取り除く（関数では書けないため）。
 * 改行を含むコマンドは扱えない（関数では1行1コマンドのため）。
 */
export async function inspectJavaSyntax(commands: string[], options: JavaSyntaxOptions = {}): Promise<JavaSyntaxInspection> {
  commands.forEach((c, i) => {
    if (/[\r\n]/.test(c)) throw new Error(`改行を含むコマンドは判定できない（${i}番目）`);
    if (c.trim().startsWith("$")) throw new Error(`マクロは展開後のコマンドを渡す必要がある（${i}番目）`);
  });
  const order = options.packOrder;
  if (order) {
    const indexes = order.flatMap((entry) => "datapack" in entry ? [entry.datapack] : []);
    if (indexes.length !== (options.datapacks?.length ?? 0) || new Set(indexes).size !== indexes.length ||
      indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= (options.datapacks?.length ?? 0)) ||
      order.some((entry) => "builtin" in entry && (!/^[a-z0-9_.-]+$/.test(entry.builtin)))) {
      throw new Error("invalid Java syntax pack order");
    }
  }
  if (commands.length === 0 && !options.datapacks?.length && !order?.length) return { checked: true, results: [], contextErrors: [], enabledPacks: "" };
  const dir = mkdtempSync(join(tmpdir(), "je2be-syntax-"));
  let java: JavaServer | undefined;
  try {
    const namespace = `je2be_syntax_${randomBytes(8).toString("hex")}`;
    const pack = join(dir, namespace);
    const fnDir = join(pack, "data", namespace, "function");
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(join(pack, "pack.mcmeta"), JSON.stringify({ pack: {
      description: "je2be: syntax check", pack_format: 121, min_format: 121, max_format: 121,
    } }));
    commands.forEach((c, i) => writeFileSync(join(fnDir, `c${i}.mcfunction`), c.replace(/^\//, "") + "\n"));
    // 判定パック自体が読まれていなければ全行を成功と誤判定してしまうため、必ず失敗する監視用関数を置く。
    writeFileSync(join(fnDir, "sentinel.mcfunction"), "je2be_intentionally_invalid_command\n");
    const context = (options.datapacks ?? []).map((source, i) => {
      const destination = join(dir, `context_${String(i).padStart(4, "0")}`);
      copySyntaxDatapack(source, destination);
      return destination;
    });
    const enabled = order ? order.map((entry) => "builtin" in entry ? entry.builtin : `file/${basename(context[entry.datapack]!)}`)
      : ["vanilla", ...context.map((path) => `file/${basename(path)}`)];
    try {
      java = await JavaServer.start({
        datapacks: [...context, pack],
        initialEnabledPacks: [...enabled, `file/${namespace}`],
      });
    } catch (error) {
      // ロック競合やファイル I/O 等を、古いログを根拠にパックの不正と誤判定しない。
      if (!(error instanceof Error) || !/^process exited .*while waiting for java server start$/.test(error.message)) throw error;
      const log = readFileSync(join(paths.servers, "java-last.log"), "utf8");
      if (!log.includes("Failed to load datapacks")) throw error;
      return { checked: false, results: [], enabledPacks: "", contextErrors: log.split("\n").filter((line) =>
        /Failed to (load|parse)|Errors in (registry|element)|Caused by:/.test(line),
      ) };
    }
    const enabledPacks = await java.exec("datapack list enabled");
    if (!enabledPacks.includes(`file/${namespace}`) || !java.log.some((line) => line.includes(`Failed to load function ${namespace}:sentinel`))) {
      throw new Error("Java syntax probe pack was not parsed; refusing to report success");
    }
    // 読み込みに失敗した関数は、起動時のログに「Failed to load function <ID>」として出る
    const errors = new Map<number, string>();
    const pattern = new RegExp(`Failed to load function ${namespace}:c(\\d+)\\b`);
    const lines = java.log;
    for (let i = 0; i < lines.length; i++) {
      const m = pattern.exec(lines[i] as string);
      if (!m) continue;
      // エラーの詳細は同じ行か次の行に出る
      const detail = (lines[i] as string).slice(m.index + m[0].length).replace(/^[:\s]+/, "") || (lines[i + 1] ?? "");
      // 例外の型の前置きを除き、Java のエラー文だけにする
      errors.set(Number(m[1]), detail.replace(/^.*Whilst parsing command on line \d+: /, "").trim());
    }
    const results = commands.map((command, i) => {
      const error = errors.get(i);
      return error === undefined ? { command, ok: true } : { command, ok: false, error };
    });
    const contextErrors = lines.filter((line) => /\/ERROR\]/.test(line) && !line.includes(namespace) && /Failed to (load|parse|read)|Couldn't (load|parse|read)|Missing references/.test(line));
    for (const name of enabled) {
      if (!enabledPacks.includes(name)) contextErrors.push(`Datapack was not enabled: ${name}`);
    }
    return { checked: true, results, contextErrors, enabledPacks };
  } finally {
    try { await java?.stop(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

/** 既存の呼び出し向け。パックの読み込み状況も必要なら inspectJavaSyntax を使う。 */
export async function checkJavaSyntax(commands: string[], options: JavaSyntaxOptions = {}): Promise<JavaSyntaxResult[]> {
  const result = await inspectJavaSyntax(commands, options);
  if (!result.checked) throw new Error(`Java datapack context failed to load: ${result.contextErrors.join("\n")}`);
  return result.results;
}
