import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertWorld, javaGrammarSources, setupJavaGrammar } from "@je2be/converter";
import { deserializeCommandIR } from "@je2be/core";
import { expect, it } from "vitest";
import { paths } from "./paths.ts";
import { loadScenarioDatapack, startScenarioJava } from "./scenario/datapack.ts";

it("bundles functions and load/tick tags from a saved Java world", async () => {
  const config = JSON.parse(readFileSync(new URL("../../../tools/servers.json", import.meta.url), "utf8")) as { java: { version: string }; chunker: { version: string } };
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
    const report = convertWorld(join(work, "java"), out, { java: paths.java, chunkerJar: join(paths.servers, "tools", `chunker-cli-${config.chunker.version}.jar`) });
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
