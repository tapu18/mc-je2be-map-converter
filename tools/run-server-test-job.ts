import { spawnSync } from "node:child_process";

const files: string[] = JSON.parse(process.env.SERVER_TEST_FILES ?? "[]");
if (!files.length) throw new Error("Server test job has no test files");
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.servers.config.ts", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
