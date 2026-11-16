import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildJavaValidationReport, JavaWorld } from "@je2be/converter";
import { inspectJavaSyntax, type JavaSyntaxInspection } from "./java-syntax.ts";
import { paths } from "./paths.ts";

describe("Java command validation with datapack context", () => {
  let directory: string;
  let plain: JavaSyntaxInspection;
  let contextual: JavaSyntaxInspection;
  const commands = [
    "execute if predicate fixture:yes run say x",
    "loot give @s loot fixture:empty",
    "item modify entity @s weapon.mainhand fixture:one",
    "execute if block ~ ~ ~ #fixture:stones run say x",
    "attribute @s minecraft:generic.max_health base set 20",
    "give @s stone[custom_model_data=1]",
    "execute if predicate fixture:missing run say x",
    "scoreboard objectives add PROBE_MUST_NOT_RUN dummy",
  ];
  const inputs = commands.map((command, i) => ({ id: `fn:${i + 1}`, command }));
  function put(path: string, value: unknown): void {
    const file = join(directory, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "je2be-validation-fixture-"));
    put("pack.mcmeta", { pack: { description: "validation fixture", pack_format: 121, min_format: 121, max_format: 121 } });
    put("data/fixture/predicate/yes.json", { type: "minecraft:random_chance", chance: 1 });
    put("data/fixture/loot_table/empty.json", { pools: [] });
    put("data/fixture/item_modifier/one.json", { type: "minecraft:set_count", count: 1 });
    put("data/fixture/tags/block/stones.json", { values: ["minecraft:stone"] });
    put("data/fixture/function/load.mcfunction", "scoreboard objectives add SHOULD_NOT_RUN dummy\n");
    put("data/minecraft/tags/function/load.json", { values: ["fixture:load"] });
    put("additional/pack.mcmeta", { pack: { description: "second context pack", pack_format: 121, min_format: 121, max_format: 121 } });
    plain = await inspectJavaSyntax(commands);
    contextual = await inspectJavaSyntax(commands, { datapacks: [directory, join(directory, "additional")] });
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it("resolves four kinds of references only when their pack definitions are loaded", () => {
    expect(plain.checked).toBe(true);
    expect(plain.results.slice(0, 4).map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(contextual.checked).toBe(true);
    expect(contextual.contextErrors).toEqual([]);
    expect(contextual.results.map((r) => r.ok)).toEqual([true, true, true, true, false, false, false, true]);
    expect(contextual.enabledPacks.indexOf("file/context_0000")).toBeLessThan(contextual.enabledPacks.indexOf("file/context_0001"));
    const report = buildJavaValidationReport(inputs, contextual, { javaVersion: "26.3", datapacks: [directory, join(directory, "additional")] });
    expect(report.summary).toMatchObject({ valid: 5, invalid: 2, unresolvedReferences: 1, contextErrors: 0 });
    expect(report.diagnostics.map((d) => d.code)).toEqual(["java-invalid-id", "java-invalid-value", "java-unresolved-reference"]);
  });

  it("does not execute the original load function or modify its body", () => {
    expect(new JavaWorld(join(paths.javaServer, "je2be-test")).scoreboard()).toEqual([]);
    expect(readFileSync(join(directory, "data/fixture/function/load.mcfunction"), "utf8")).toBe("scoreboard objectives add SHOULD_NOT_RUN dummy\n");
  });

  it("reports an unreadable registry context as unchecked, not as invalid commands", async () => {
    put("data/fixture/predicate/broken.json", { type: "fixture:nonexistent_type" });
    const batch = await inspectJavaSyntax(commands, { datapacks: [directory] });
    expect(batch.checked).toBe(false);
    expect(batch.results).toEqual([]);
    expect(batch.contextErrors.join("\n")).toContain("Failed to load datapacks");
    const report = buildJavaValidationReport(inputs, batch, { javaVersion: "26.3", datapacks: [directory] });
    expect(report.summary).toMatchObject({ invalid: 0, valid: 0, notChecked: 8 });
    expect(report.complete).toBe(false);
  });
});
