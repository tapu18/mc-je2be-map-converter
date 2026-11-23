import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
it("checks generated Java-accepted rewrites by loading BDS functions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shape-bds-test-"));
  try {
    const java = join(dir, "java.json"), bedrock = join(dir, "bedrock.json");
    await run(process.execPath, ["tools/shape-java-audit.ts", java]);
    await run(process.execPath, ["tools/shape-bedrock-audit.ts", java, bedrock]);
    const audit = JSON.parse(await readFile(bedrock, "utf8")) as { results: { command: string; bedrock: string }[] };
    expect(audit.results.length).toBeGreaterThan(0);
    // 現時点の既知の不一致。修正時はこの一覧と実測記録を更新する。
    expect(audit.results.filter(r => r.bedrock === "rejected").map(r => r.command)).toEqual(["time query time"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
