// 作者が読む変換レポート（#351）。Java で保存したワールドを CLI と同じ経路で変換し、Markdown の場所と理由を確かめる。
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertOutput, javaGrammarSources, setupJavaGrammar } from "@je2be/converter";
import { expect, it } from "vitest";
import { paths } from "./paths.ts";
import { rewriteResources } from "./rewrite-resources.ts";
import { loadScenarioDatapack, startScenarioJava } from "./scenario/datapack.ts";

const config = JSON.parse(readFileSync(new URL("../../../tools/servers.json", import.meta.url), "utf8")) as { java: { version: string; dataVersion: number }; chunker: { version: string } };

it("shows a command block, a data pack function and an omitted entity with Java locations and Japanese reasons", async () => {
  const source = javaGrammarSources().find(s => s.version === config.java.version);
  if (!source) throw new Error("fixed grammar source missing");
  await setupJavaGrammar(source);
  await rewriteResources();
  // マクロの値でコマンド名が変わる行は Java では読み込めるが、事前に変換できない。
  const pack = { functions: { "demo:macro": ["$$(command) hello"] } };
  const java = await startScenarioJava(pack);
  const work = mkdtempSync(join(tmpdir(), "je2be-convert-report-"));
  try {
    await loadScenarioDatapack(java, pack, []);
    const command = 'tellraw @a {"keybind":"key.jump"}';
    expect(await java.exec(`setblock 2 -60 2 minecraft:command_block{Command:'${command}'}`)).toMatch(/Changed the block/);
    expect(await java.exec("summon minecraft:marker 5 -60 5")).toMatch(/Summoned/);
    await java.dump({});
    await java.stop();
    cpSync(java.worldDirectory, join(work, "java"), { recursive: true });
    const result = convertOutput(join(work, "java"), join(work, "out.mcworld"), { java: paths.java, chunker: join(paths.servers, "tools", `chunker-cli-${config.chunker.version}.jar`) });
    expect(result.markdown).toBe(join(work, "out.mcworld.report.md"));
    const md = readFileSync(result.markdown, "utf8");
    const json = JSON.parse(readFileSync(result.report, "utf8")) as { warnings: { code: string }[]; limitations: string[] };
    expect(json.warnings.map(w => w.code)).not.toContain("UNCLASSIFIED");
    expect(json.warnings.map(w => w.code)).toEqual(expect.arrayContaining(["CMD_NOT_NATIVE", "DP_MACRO_SHAPE", "ENTITY_JAVA_ONLY"]));
    expect(md).toMatch(/\| minecraft:overworld \(2, -60, 2\) \| `tellraw @a \{"keybind":"key\.jump"\}` \| [^|]*[ぁ-んァ-ヶ一-龠][^|]* \|/);
    expect(md).toMatch(/\| je2be-scenario data\/demo\/function\/macro\.mcfunction:1[^|]* \| `\$\$\(command\) hello` \| マクロの値によってコマンドの形が変わり得る/);
    expect(md).toMatch(/\| minecraft:overworld \(5\.50, -60, 5\.50\) \| `minecraft:marker[^`]*` \| Java 専用のエンティティ/);
    expect(md).toContain(`入力の版: DataVersion ${config.java.dataVersion}`);
    for (const english of ["macro hole", "command parse failed", "not supported", "grammar unavailable"]) expect(md).not.toContain(english);
  } finally { await java.stop(); rmSync(work, { recursive: true, force: true }); }
});
