import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { ZIP_MAX_BYTES, ZIP_MAX_FILES } from "@je2be/converter/zip";
import { afterEach, describe, expect, it } from "vitest";
import { copySyntaxDatapack } from "./syntax-datapacks.ts";
import { checkJavaSyntax } from "./java-syntax.ts";

const directories: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), "je2be-copy-test-")); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("syntax datapack copies", () => {
  it("preserves definitions and function IDs but stubs functions including overlays without touching originals", () => {
    const source = temp(), destination = join(temp(), "copy");
    for (const path of ["data/test/function", "overlay/data/test/function", "data/test/predicate"]) mkdirSync(join(source, path), { recursive: true });
    const body = "scoreboard objectives add SHOULD_NOT_RUN dummy\n";
    for (const path of ["data/test/function/load.mcfunction", "overlay/data/test/function/tick.mcfunction"]) writeFileSync(join(source, path), body);
    writeFileSync(join(source, "data/test/predicate/yes.json"), '{"type":"minecraft:random_chance","chance":1}');
    copySyntaxDatapack(source, destination);
    expect(readFileSync(join(source, "data/test/function/load.mcfunction"), "utf8")).toBe(body);
    expect(readFileSync(join(destination, "data/test/function/load.mcfunction"), "utf8")).toMatch(/^# je2be/);
    expect(readFileSync(join(destination, "overlay/data/test/function/tick.mcfunction"), "utf8")).toMatch(/^# je2be/);
    expect(readFileSync(join(destination, "data/test/predicate/yes.json"))).toEqual(readFileSync(join(source, "data/test/predicate/yes.json")));
  });

  it("rejects links before stubbing can follow them to original files", () => {
    const source = temp(), outside = join(temp(), "outside.mcfunction");
    writeFileSync(outside, "say unchanged");
    symlinkSync(outside, join(source, "load.mcfunction"));
    expect(() => copySyntaxDatapack(source, join(temp(), "copy"))).toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("say unchanged");
  });

  it("reads ZIPs without changing the archive and stubs overlay functions", () => {
    const archive = join(temp(), "pack.zip"), destination = join(temp(), "copy");
    writeFileSync(archive, zipSync({ "overlay/data/test/function/load.mcfunction": Buffer.from("say SHOULD_NOT_RUN"), "data/test/predicate/yes.json": Buffer.from("{}") }));
    const original = readFileSync(archive);
    copySyntaxDatapack(archive, destination);
    expect(readFileSync(archive)).toEqual(original);
    expect(readFileSync(join(destination, "overlay/data/test/function/load.mcfunction"), "utf8")).toMatch(/^# je2be/);
    expect(readFileSync(join(destination, "data/test/predicate/yes.json"), "utf8")).toBe("{}");
  });

  it.each(["../outside", "/absolute", "data/../../outside", "data\\evil", "link"])("rejects unsafe ZIP entry %s", (name) => {
    const archive = join(temp(), "unsafe.zip");
    const bytes = zipSync({ [name]: Buffer.from("target") });
    if (name === "link") { const pos = Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); new DataView(bytes.buffer).setUint32(pos + 38, 0o120777 << 16, true); }
    writeFileSync(archive, bytes);
    expect(() => copySyntaxDatapack(archive, join(temp(), "copy"))).toThrow();
  });

  it("rejects excessive declared expanded size and forged small sizes", () => {
    const archive = join(temp(), "large.zip");
    const bytes = zipSync({ "file": Buffer.from("a".repeat(1000)) });
    const pos = Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const view = new DataView(bytes.buffer);
    view.setUint32(pos + 24, ZIP_MAX_BYTES + 1, true);
    writeFileSync(archive, bytes);
    expect(() => copySyntaxDatapack(archive, join(temp(), "copy"))).toThrow(/expanded size/);
    view.setUint32(pos + 24, 1, true);
    writeFileSync(archive, bytes);
    expect(() => copySyntaxDatapack(archive, join(temp(), "copy"))).toThrow();
  });

  it("rejects too many ZIP entries and leaves existing destinations unchanged", () => {
    const archive = join(temp(), "many.zip"), destination = join(temp(), "copy");
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= ZIP_MAX_FILES; i++) files[String(i)] = new Uint8Array();
    writeFileSync(archive, zipSync(files));
    expect(() => copySyntaxDatapack(archive, destination)).toThrow(/count limit/);
    mkdirSync(destination); writeFileSync(join(destination, "keep"), "unchanged");
    expect(() => copySyntaxDatapack(archive, destination)).toThrow();
    expect(readFileSync(join(destination, "keep"), "utf8")).toBe("unchanged");
  });

  it("rejects multiline commands and unexpanded macros before starting Java", async () => {
    await expect(checkJavaSyntax(["say x\nsay y"])).rejects.toThrow(/改行/);
    await expect(checkJavaSyntax(["$say $(v)"])).rejects.toThrow(/マクロ/);
    await expect(checkJavaSyntax([])).resolves.toEqual([]);
  });
});
