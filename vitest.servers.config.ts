import { appendFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const retryReport = process.env.JE2BE_RETRY_REPORT;

// 実サーバー（Java版サーバー、BDS）を起動するテスト。サーバーは同じディレクトリを使うため直列に実行する。
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.servers.test.ts", "poc/**/*.servers.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    retry: retryReport ? 1 : 0,
    reporters: retryReport ? ["default", {
      onTestCaseResult(test) {
        const retries = test.diagnostic()?.retryCount ?? 0;
        if (!retries) return;
        const entry = { file: test.module.relativeModuleId, test: test.fullName, retries, result: test.result().state };
        appendFileSync(retryReport, JSON.stringify(entry) + "\n");
        if (entry.result === "passed") console.warn(`再試行で成功: ${entry.file} > ${entry.test} (${retries}回)`);
      },
    }] : ["default"],
  },
});
