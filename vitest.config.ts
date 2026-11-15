import { defineConfig } from "vitest/config";

// 既定のテストはNodeだけで完結するもの。実サーバーを使うテスト（*.servers.test.ts）は
// `npm run test:servers` で別に実行する（vitest.servers.config.ts）。
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: ["**/*.servers.test.ts", "**/node_modules/**"],
  },
});
