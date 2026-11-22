// 判定用にコピーしたデータパックの関数を空にする。元のパックは変更しない。
// リソース定義・タグ・関数 ID は残すが、load/tick や報酬からの処理は実行させない。
import { cpSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { extractDatapackZip } from "@je2be/converter/zip";
import { join } from "node:path";

export function copySyntaxDatapack(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`symlink in syntax datapack: ${source}`);
  if (stat.isFile()) {
    extractDatapackZip(source, destination);
  } else if (stat.isDirectory()) cpSync(source, destination, { recursive: true, filter: (path) => {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`symlink in syntax datapack: ${path}`);
    return true;
  } });
  else throw new Error(`syntax datapack must be a directory or ZIP: ${source}`);
  const stub = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stub(path);
      else if (entry.name.endsWith(".mcfunction")) writeFileSync(path, "# je2be: validation-only function placeholder\n");
    }
  };
  stub(destination);
}
