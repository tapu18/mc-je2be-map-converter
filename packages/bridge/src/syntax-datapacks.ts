// 判定用にコピーしたデータパックの関数を空にする。元のパックは変更しない。
// リソース定義・タグ・関数 ID は残すが、load/tick や報酬からの処理は実行させない。
import { cpSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function copySyntaxDatapack(source: string, destination: string): void {
  if (!lstatSync(source).isDirectory()) throw new Error(`syntax datapack must be a directory (extract ZIP first): ${source}`);
  cpSync(source, destination, { recursive: true, filter: (path) => {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`symlink in syntax datapack: ${path}`);
    return true;
  } });
  const stub = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stub(path);
      else if (entry.name.endsWith(".mcfunction")) writeFileSync(path, "# je2be: validation-only function placeholder\n");
    }
  };
  stub(destination);
}
