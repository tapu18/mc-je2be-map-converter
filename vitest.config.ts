import { existsSync, globSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { paths } from "./packages/bridge/src/paths.ts";

// 生成データを使う Node テストは、データがない開発環境でも通常のテストを実行できる。
const hasData = existsSync(paths.commandsReport);
if (!hasData) {
  const count = [...globSync("packages/*/src/**/*.data.test.ts")].length;
  const message = `生成データがないため ${count} 件のデータテストファイルをスキップします。npm run setup:servers を実行してください。`;
  if (process.env.JE2BE_REQUIRE_TEST_DATA === "1") throw new Error(message);
  console.warn(message);
}

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: ["**/*.servers.test.ts", "**/node_modules/**", ...(!hasData ? ["**/*.data.test.ts"] : [])],
  },
});
