// Java 版サーバーに、コマンドが文法として正しいかを判定させる（#13 のパーサの正解データ）。
// コマンド1つを関数1つにしたデータパックを入れて起動し、読み込みに失敗した関数をログから拾う。
// 関数は読み込み時に全行がパースされ、1行でも失敗すると関数ごと読み込まれない（実測、#13）。
// 実行はしないので、ワールドの状態には影響しない。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JavaServer } from "./java.ts";

const NAMESPACE = "je2be_syntax";

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
export async function checkJavaSyntax(commands: string[]): Promise<JavaSyntaxResult[]> {
  const dir = mkdtempSync(join(tmpdir(), "je2be-syntax-"));
  const pack = join(dir, NAMESPACE);
  const fnDir = join(pack, "data", NAMESPACE, "function");
  mkdirSync(fnDir, { recursive: true });
  writeFileSync(
    join(pack, "pack.mcmeta"),
    JSON.stringify({ pack: { description: "je2be: syntax check", pack_format: 121, min_format: 121, max_format: 121 } }),
  );
  commands.forEach((c, i) => {
    if (/[\r\n]/.test(c)) throw new Error(`改行を含むコマンドは判定できない（${i}番目）`);
    writeFileSync(join(fnDir, `c${i}.mcfunction`), c.replace(/^\//, "") + "\n");
  });
  let java: JavaServer | undefined;
  try {
    java = await JavaServer.start({ datapacks: [pack] });
    // 読み込みに失敗した関数は、起動時のログに「Failed to load function <ID>」として出る
    const errors = new Map<number, string>();
    const pattern = new RegExp(`Failed to load function ${NAMESPACE}:c(\\d+)`);
    const lines = java.log;
    for (let i = 0; i < lines.length; i++) {
      const m = pattern.exec(lines[i] as string);
      if (!m) continue;
      // エラーの詳細は同じ行か次の行に出る
      const detail = (lines[i] as string).slice(m.index + m[0].length).replace(/^[:\s]+/, "") || (lines[i + 1] ?? "");
      // 例外の型の前置きを除き、Java のエラー文だけにする
      errors.set(Number(m[1]), detail.replace(/^.*Whilst parsing command on line \d+: /, "").trim());
    }
    return commands.map((command, i) => {
      const error = errors.get(i);
      return error === undefined ? { command, ok: true } : { command, ok: false, error };
    });
  } finally {
    await java?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
