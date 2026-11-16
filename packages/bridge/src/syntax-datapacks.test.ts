import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
    execFileSync("python3", ["-c", "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n z.writestr('overlay/data/test/function/load.mcfunction', 'say SHOULD_NOT_RUN')\n z.writestr('data/test/predicate/yes.json', '{}')", archive]);
    const original = readFileSync(archive);
    copySyntaxDatapack(archive, destination);
    expect(readFileSync(archive)).toEqual(original);
    expect(readFileSync(join(destination, "overlay/data/test/function/load.mcfunction"), "utf8")).toMatch(/^# je2be/);
    expect(readFileSync(join(destination, "data/test/predicate/yes.json"), "utf8")).toBe("{}");
  });

  it.each(["../outside", "/absolute", "data/../../outside", "data\\evil", "link"])("rejects unsafe ZIP entry %s", (name) => {
    const archive = join(temp(), "unsafe.zip");
    execFileSync("python3", ["-c", "import zipfile,sys\ni=zipfile.ZipInfo(sys.argv[2])\ni.external_attr=(0o120777 << 16) if sys.argv[2]=='link' else 0\nwith zipfile.ZipFile(sys.argv[1], 'w') as z: z.writestr(i, 'target')", archive, name]);
    expect(() => copySyntaxDatapack(archive, join(temp(), "copy"))).toThrow();
  });

  it("rejects multiline commands and unexpanded macros before starting Java", async () => {
    await expect(checkJavaSyntax(["say x\nsay y"])).rejects.toThrow(/改行/);
    await expect(checkJavaSyntax(["$say $(v)"])).rejects.toThrow(/マクロ/);
    await expect(checkJavaSyntax([])).resolves.toEqual([]);
  });
});
