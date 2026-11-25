import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertWorld, javaGrammarSources, loadGrammarTree, setupJavaGrammar } from "@je2be/converter";
import { CommandParser, deserializeCommandIR, toCommandIR } from "@je2be/core";
import { expect, it } from "vitest";
import { paths } from "./paths.ts";
import { loadScenarioDatapack, startScenarioJava } from "./scenario/datapack.ts";

const config = JSON.parse(readFileSync(new URL("../../../tools/servers.json", import.meta.url), "utf8")) as { java: { version: string }; chunker: { version: string } };
const conversion = { java: paths.java, chunkerJar: join(paths.servers, "tools", `chunker-cli-${config.chunker.version}.jar`) };

it("bundles functions and load/tick tags from a saved Java world", async () => {
  const source = javaGrammarSources().find(s => s.version === config.java.version);
  if (!source) throw new Error("fixed grammar source missing");
  await setupJavaGrammar(source);
  const pack = { functions: { "demo:a": ["say hello"], "demo:b": ["say world"] }, functionTags: { "minecraft:load": { values: ["demo:a"] }, "minecraft:tick": { values: ["demo:b"] } } };
  const java = await startScenarioJava(pack);
  const work = mkdtempSync(join(tmpdir(), "je2be-datapack-convert-"));
  try {
    await loadScenarioDatapack(java, pack, []);
    await java.dump({});
    await java.stop();
    cpSync(java.worldDirectory, join(work, "java"), { recursive: true });
    const out = join(work, "bedrock");
    const report = convertWorld(join(work, "java"), out, conversion);
    expect(report.datapacks.functions).toBe(3); // includes scenario reload sentinel
    expect(report.datapacks.diagnostics).toEqual([]);
    const js = readFileSync(join(out, "behavior_packs", "je2be_init", "scripts", "datapacks.js"), "utf8");
    const data = JSON.parse(js.slice("export const datapacks = ".length, -2));
    const entry = data.packs[0];
    expect(Object.keys(entry.functions).sort()).toEqual(["demo:a", "demo:b", "je2be_scenario:reload_ready"]);
    expect(entry.tags).toEqual(pack.functionTags);
    expect(deserializeCommandIR(entry.functions["demo:a"][0])).toMatchObject({ ok: true, document: { ir: { source: "say hello" } } });
  } finally { await java.stop(); rmSync(work, { recursive: true, force: true }); }
});

it.each([
  { version: "1.20.5", command: "time set noon", grammarVersion: "1.20.6" },
  { version: "1.21.1", command: "execute if items block 1 2 3 container.0 minecraft:stone run time set noon", grammarVersion: "1.21.1" },
  { version: "26.2", command: "data modify block 1 2 3 foo set from block 4 5 6", grammarVersion: "26.2" },
])("bundles normalized functions and reports unconvertible functions from Java $version", async ({ version, command, grammarVersion }) => {
  const sources = javaGrammarSources();
  const grammar = await setupJavaGrammar(sources.find(s => s.version === version)!);
  // 1.20.5 と 1.20.6 は同一の pack_format と文法を持つ。両方があると後者が選ばれる。
  if (version === "1.20.5") await setupJavaGrammar(sources.find(s => s.version === "1.20.6")!);
  const current = await setupJavaGrammar(sources.find(s => s.version === config.java.version)!);
  const pack = { functions: { "demo:valid": [command], "demo:invalid": [command, "return run schedule clear foo"] } };
  const javaVersion = { ...grammar, runtime: grammar, functionDirectory: grammar.source.functionDirectory };
  const java = await startScenarioJava(pack, javaVersion);
  const work = mkdtempSync(join(tmpdir(), "je2be-datapack-normalize-"));
  try {
    await loadScenarioDatapack(java, pack, [], javaVersion);
    await java.stop();
    const out = join(work, "bedrock");
    const report = convertWorld(java.worldDirectory, out, conversion);
    expect(report.datapacks.diagnostics).toEqual([{
      pack: "je2be-scenario", path: `data/demo/${grammar.source.functionDirectory}/invalid.mcfunction:2`,
      reason: expect.stringContaining("26.2 → 26.3: schedule clear"), start: 26, end: 29,
    }]);
    const js = readFileSync(join(out, "behavior_packs", "je2be_init", "scripts", "datapacks.js"), "utf8");
    const data = JSON.parse(js.slice("export const datapacks = ".length, -2));
    const entry = data.packs[0];
    expect(entry.grammar).toBe(grammarVersion);
    expect(Object.keys(entry.functions).sort()).toEqual(["demo:valid", "je2be_scenario:reload_ready"]);
    const parsed = new CommandParser(loadGrammarTree(current), { textFormat: current.textFormat }).parse(command);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(deserializeCommandIR(entry.functions["demo:valid"][0])).toEqual({
      ok: true, document: { grammarVersion, textFormat: grammar.textFormat, ir: toCommandIR(command, parsed.nodes) },
    });
  } finally { await java.stop(); rmSync(work, { recursive: true, force: true }); }
});
