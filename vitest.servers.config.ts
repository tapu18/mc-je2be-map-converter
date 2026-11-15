import { defineConfig } from "vitest/config";

// 実サーバー（Java版サーバー、BDS）を起動するテスト。サーバーは同じディレクトリを使うため直列に実行する。
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.servers.test.ts", "poc/**/*.servers.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
