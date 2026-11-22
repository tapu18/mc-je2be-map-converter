import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeWorldZip } from "@je2be/converter/zip";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildJavaValidationReport, JavaWorld, readJavaValidationContext } from "@je2be/converter";
import { JavaServer } from "./java.ts";
import { inspectJavaSyntax } from "./java-syntax.ts";
import { paths } from "./paths.ts";

it("uses ZIP and directory definitions identically and preserves a saved world's enabled selection and order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "je2be-pack-context-"));
  function put(pack: string, path: string, value: unknown): void {
    const file = join(dir, pack, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }
  const metadata = { pack: { description: "validation context fixture", pack_format: 121, min_format: 121, max_format: 121 } };
  const commands = ["execute if predicate fixture:yes run say x", "execute if predicate fixture:disabled run say x", "execute if predicate fixture:overlay run say x"];
  try {
    for (const name of ["first", "second", "disabled"]) put(name, "pack.mcmeta", metadata);
    put("first", "data/fixture/predicate/yes.json", { type: "minecraft:random_chance", chance: 1 });
    // The lower-priority pack has a broken definition of the same ID. Loading
    // succeeds only when the saved priority really puts first above second.
    put("second", "data/fixture/predicate/yes.json", { type: "fixture:invalid_lower_priority_type" });
    put("disabled", "data/fixture/predicate/disabled.json", { type: "minecraft:random_chance", chance: 1 });
    put("first", "pack.mcmeta", { ...metadata, overlays: { entries: [{ directory: "overlay", min_format: 121, max_format: 121 }] } });
    put("first", "overlay/data/fixture/predicate/overlay.json", { type: "minecraft:random_chance", chance: 1 });
    // Save genuine Java DataPacks state, including a disabled pack.
    const java = await JavaServer.start({ datapacks: [join(dir, "first"), join(dir, "second"), join(dir, "disabled")], initialEnabledPacks: ["vanilla", "file/second", "file/first"] });
    try { await java.exec("datapack disable \"file/disabled\""); }
    finally { await java.stop(); }
    cpSync(join(paths.javaServer, "je2be-test"), join(dir, "world"), { recursive: true });
    // These bodies must never run during validation, including the active overlay.
    for (const prefix of ["", "overlay/"]) {
      put("first", `${prefix}data/fixture/function/load.mcfunction`, "scoreboard objectives add MUST_NOT_RUN dummy\n");
      put("first", `${prefix}data/minecraft/tags/function/load.json`, { values: ["fixture:load"] });
    }
    cpSync(join(dir, "first"), join(dir, "world/datapacks/first"), { recursive: true });
    const zip = join(dir, "first.zip");
    writeWorldZip(join(dir, "first"), zip);
    const originalZip = readFileSync(zip);
    const directory = await inspectJavaSyntax(commands, { datapacks: [join(dir, "first")] });
    const zipped = await inspectJavaSyntax(commands, { datapacks: [zip] });
    expect(zipped.results).toEqual(directory.results);
    expect(directory.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(directory.contextErrors).toEqual([]);
    expect(zipped.contextErrors).toEqual([]);
    expect(readFileSync(zip)).toEqual(originalZip);
    expect(new JavaWorld(join(paths.javaServer, "je2be-test")).scoreboard()).toEqual([]);
    const context = readJavaValidationContext(join(dir, "world"));
    expect(context.enabled).toEqual(["vanilla", "file/second", "file/first"]);
    expect(context.disabled).toContain("file/disabled");
    const batch = await inspectJavaSyntax(commands, { datapacks: context.datapacks, packOrder: context.packOrder });
    expect(batch.results).toEqual(directory.results);
    expect(batch.contextErrors).toEqual([]);
    expect(batch.enabledPacks.indexOf("file/context_0000")).toBeLessThan(batch.enabledPacks.indexOf("file/context_0001"));
    expect(new JavaWorld(join(paths.javaServer, "je2be-test")).scoreboard()).toEqual([]);
    expect(readFileSync(join(dir, "world/datapacks/first/overlay/data/fixture/function/load.mcfunction"), "utf8")).toContain("MUST_NOT_RUN");
    const report = buildJavaValidationReport(commands.map((command, i) => ({ id: String(i), command })), batch, { javaVersion: "26.3", datapacks: context.datapacks, sourceContext: context });
    expect(report.sourceContext?.disabled).toContain("file/disabled");
    expect(report.limitations.join()).toContain("#58");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
