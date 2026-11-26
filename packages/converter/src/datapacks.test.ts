import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import AdmZip from "adm-zip";
import { deserializeCommandIR, writeNbt, type NbtTag } from "@je2be/core";
import { expect, it, vi } from "vitest";
import { collectDatapacks } from "./datapacks.ts";

vi.mock("./java-grammars.ts", () => ({
  loadJavaGrammars: () => [
    { version: "test", dataVersion: 1, packFormat: 42, textFormat: "json", source: { functionDirectory: "function" } },
    { version: "1.20.4", dataVersion: 3700, packFormat: 26, textFormat: "json", source: { functionDirectory: "functions" } },
  ],
  loadGrammarTree: () => ({ type: "root", children: {
    say: { type: "literal", executable: true },
    give: { type: "literal", children: { targets: {
      type: "argument", parser: "minecraft:entity", children: { item: { type: "argument", parser: "minecraft:item_stack", executable: true } },
    } } },
  } }),
}));

it("collects enabled folder and zip functions and tags in saved order and reports omissions", () => {
  const world = mkdtempSync(join(tmpdir(), "je2be-packs-"));
  try {
    const strings = (values: string[]): NbtTag => ({ type: "list", elementType: "string", value: values.map(value => ({ type: "string", value })) });
    const compound = (entries: [string, NbtTag][]): NbtTag & { type: "compound" } => ({ type: "compound", value: new Map(entries) });
    writeFileSync(join(world, "level.dat"), gzipSync(writeNbt({ name: "", tag: compound([["Data", compound([["DataVersion", { type: "int", value: 1 }], ["DataPacks", compound([["Enabled", strings(["vanilla", "file/one", "file/two.zip"])], ["Disabled", strings(["file/off"])]] )]])]]) }, "java")));
    const folder = join(world, "datapacks", "one");
    mkdirSync(join(folder, "data", "demo", "function"), { recursive: true });
    mkdirSync(join(folder, "data", "minecraft", "tags", "function"), { recursive: true });
    mkdirSync(join(folder, "data", "demo", "advancement"), { recursive: true });
    writeFileSync(join(folder, "pack.mcmeta"), JSON.stringify({ pack: { min_format: 42, max_format: 42 } }));
    writeFileSync(join(folder, "data", "demo", "function", "a.mcfunction"), "# comment\nsay\n");
    writeFileSync(join(folder, "data", "minecraft", "tags", "function", "load.json"), JSON.stringify({ values: ["demo:a"] }));
    writeFileSync(join(folder, "data", "demo", "advancement", "a.json"), "{}");
    const zip = new AdmZip();
    zip.addFile("pack.mcmeta", Buffer.from(JSON.stringify({ pack: { pack_format: 42 }, overlays: { entries: [{ directory: "extra", formats: 42 }] } })));
    zip.addFile("data/demo/function/b.mcfunction", Buffer.from("invalid\n"));
    zip.addFile("extra/data/demo/function/b.mcfunction", Buffer.from("say\n"));
    zip.addFile("data/minecraft/tags/function/tick.json", Buffer.from('{"replace":true,"values":["demo:b"]}'));
    zip.writeZip(join(world, "datapacks", "two.zip"));
    const result = collectDatapacks(world);
    expect(result.report).toEqual({ functions: 2, omitted: ["advancement"], diagnostics: [] });
    expect(result.packs.map(p => p.name)).toEqual(["one", "two.zip"]);
    expect(result.packs[0]!.tags["minecraft:load"]).toEqual({ values: ["demo:a"] });
    expect(result.packs[1]!.tags["minecraft:tick"]).toEqual({ replace: true, values: ["demo:b"] });
    expect(deserializeCommandIR(result.packs[0]!.functions["demo:a"]![0]!)).toMatchObject({ ok: true, document: { grammarVersion: "test", ir: { source: "say" } } });
    writeFileSync(join(folder, "pack.mcmeta"), JSON.stringify({ pack: { pack_format: 999 } }));
    const unknown = collectDatapacks(world);
    expect(unknown.packs[0]!.functions).toEqual({});
    expect(unknown.report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ pack: "one", path: "pack.mcmeta", reason: "unavailable" }), expect.objectContaining({ pack: "one", path: "data/demo/function/a.mcfunction", reason: "grammar unavailable" })]));
  } finally { rmSync(world, { recursive: true, force: true }); }
});

it("selects 1.20.4 for a saved world and its legacy data pack", () => {
  const world = mkdtempSync(join(tmpdir(), "je2be-1204-"));
  try {
    const compound = (entries: [string, NbtTag][]): NbtTag & { type: "compound" } => ({ type: "compound", value: new Map(entries) });
    const enabled: NbtTag = { type: "list", elementType: "string", value: [{ type: "string", value: "file/old" }] };
    writeFileSync(join(world, "level.dat"), gzipSync(writeNbt({ name: "", tag: compound([["Data", compound([["DataVersion", { type: "int", value: 3700 }], ["DataPacks", compound([["Enabled", enabled], ["Disabled", { type: "list", elementType: "string", value: [] }]])]])]]) }, "java")));
    const pack = join(world, "datapacks", "old");
    mkdirSync(join(pack, "data", "demo", "functions"), { recursive: true });
    writeFileSync(join(pack, "pack.mcmeta"), JSON.stringify({ pack: { pack_format: 26 } }));
    const dir = join(pack, "data", "demo", "functions");
    writeFileSync(join(dir, "a.mcfunction"), "give @s stick{foo:1b}\n");
    writeFileSync(join(dir, "unsupported.mcfunction"), "  give @s stick{HideFlags:1}\n");
    const result = collectDatapacks(world);
    expect(result.packs[0]).toMatchObject({ grammar: "1.20.4" });
    const decoded = deserializeCommandIR(result.packs[0]!.functions["demo:a"]![0]!);
    expect(decoded).toMatchObject({ ok: true, document: { grammarVersion: "1.20.4", ir: { command: { nodes: [
      expect.anything(), { value: { kind: "item", components: [{ key: "minecraft:custom_data" }] } },
    ] } } } });
    if (decoded.ok) expect(decoded.document.ir.command?.nodes[1]?.value).not.toHaveProperty("legacyTag");
    expect(result.packs[0]!.functions["demo:unsupported"]).toBeUndefined();
    expect(result.report.diagnostics).toEqual([{
      pack: "old", path: "data/demo/functions/unsupported.mcfunction:1",
      reason: expect.stringContaining("1.20.4 → 1.20.5"), start: 10, end: 28,
    }]);
  } finally { rmSync(world, { recursive: true, force: true }); }
});
