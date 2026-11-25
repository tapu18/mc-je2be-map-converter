import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

// 入力を限定して束ね、外部に残すのは実行環境と変換時生成データだけ。
const result = await build({
  entryPoints: ["packages/runtime-host/src/main.ts"], bundle: true, format: "esm",
  platform: "neutral", target: "es2022", write: false, metafile: true,
  external: ["@minecraft/server", "./data.js", "./storage.js"],
});
const output = result.outputFiles[0]!;
for (const entry of Object.values(result.metafile.outputs)) {
  for (const imp of entry.imports) {
    if (!imp.external || !["@minecraft/server", "./data.js", "./storage.js"].includes(imp.path)) {
      throw new Error(`unexpected runtime import: ${imp.path}`);
    }
  }
}
// 保守的に文字列・コメントも含めて検査し、算出プロパティ表記も拒否する。
if (/\b(?:process|Buffer|require)\b|node:/.test(output.text)) {
  throw new Error("Node API reference in runtime bundle");
}
mkdirSync("packages/runtime-host/pack/scripts", { recursive: true });
writeFileSync("packages/runtime-host/pack/scripts/main.js", output.contents);
