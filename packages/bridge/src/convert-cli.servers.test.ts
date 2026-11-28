import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { javaGrammarSources, setupJavaGrammar } from "@je2be/converter";
import { BedrockServer } from "./bedrock.ts";
import { JavaServer } from "./java.ts";
import { paths, repoRoot } from "./paths.ts";

function digest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name);
      if (statSync(file).isDirectory()) walk(file);
      else { hash.update(relative(dir, file)); hash.update(readFileSync(file)); }
    }
  };
  walk(dir); return hash.digest("hex");
}

it("converts through the CLI to a directory and importable archive without changing its source", async () => {
  await setupJavaGrammar(javaGrammarSources().find(s => s.version === "26.3")!);
  const java = await JavaServer.start();
  try {
    await java.exec("scoreboard objectives add t dummy");
    await java.exec("scoreboard players set kept t 42");
    await java.exec("scoreboard players set zero t 0");
    await java.exec('setblock 2 -60 2 minecraft:command_block[facing=south]{Command:"data get storage fixture:missing",auto:0b}');
    await java.dump({});
  } finally { await java.stop(); }
  const work = mkdtempSync(join(paths.servers, "cli-output-"));
  const source = join(work, "java");
  cpSync(join(paths.javaServer, "je2be-test"), source, { recursive: true });
  const before = digest(source);
  const cli = join(repoRoot, "packages/converter/src/cli.ts");
  const invoke = (output: string) => JSON.parse(execFileSync(process.execPath, [cli, "convert", source, "--out", output], { encoding: "utf8", timeout: 600_000 })) as { status: string; report: string; markdown: string; clearConfirmed: boolean };
  try {
    const directory = join(work, "directory");
    const dirResult = invoke(directory);
    expect(existsSync(join(directory, "level.dat"))).toBe(true);
    expect(existsSync(join(directory, "db"))).toBe(true);
    expect(dirResult).toMatchObject({ status: "partial", clearConfirmed: false });
    const archive = join(work, "fixture.mcworld");
    const zipResult = invoke(archive);
    const names = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).split("\n");
    expect(names).toContain("level.dat");
    expect(names.some(n => n.startsWith("db/"))).toBe(true);
    expect(names).toContain("world_behavior_packs.json");
    expect(names).toContain("behavior_packs/je2be_init/LICENSE.geyser.txt");
    expect(names).toContain("NOTICE.geyser.txt");
    const report = JSON.parse(readFileSync(zipResult.report, "utf8")) as { commands: { counts: { unsupported: number } }; limitations: string[] };
    expect(report.commands.counts.unsupported).toBe(1);
    expect(report.limitations.length).toBeGreaterThan(0);
    expect(zipResult.markdown).toBe(`${archive}.report.md`);
    expect(readFileSync(zipResult.markdown, "utf8")).toContain("CMD_NOT_NATIVE");
    const archiveHash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    expect(() => invoke(archive)).toThrow();
    expect(createHash("sha256").update(readFileSync(archive)).digest("hex")).toBe(archiveHash);
    expect(digest(source)).toBe(before);
    const loaded = join(work, "loaded"); mkdirSync(loaded);
    execFileSync("unzip", ["-q", archive, "-d", loaded]);
    const bds = await BedrockServer.start({ world: loaded, worldSettings: "preserve", tickingArea: false });
    try {
      const scores = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
      expect(scores.result?.find(o => o.objective === "t")?.scores.find(s => s.participant === "kept")?.score).toBe(42);
      expect(scores.result?.find(o => o.objective === "t")?.scores.find(s => s.participant === "zero")?.score).toBe(0);
    } finally { await bds.stop(); }
    if (process.env.JE2BE_ACCEPTANCE_ARTIFACTS) {
      const target = process.env.JE2BE_ACCEPTANCE_ARTIFACTS;
      mkdirSync(target, { recursive: true });
      cpSync(archive, join(target, "fixture.mcworld"), { force: false, errorOnExist: true });
      cpSync(zipResult.report, join(target, "fixture.report.json"), { force: false, errorOnExist: true });
      cpSync(zipResult.markdown, join(target, "fixture.report.md"), { force: false, errorOnExist: true });
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});
