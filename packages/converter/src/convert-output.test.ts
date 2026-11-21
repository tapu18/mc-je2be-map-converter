import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkedOutputPaths, packageMcworld } from "./convert-output.ts";

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "je2be-output-unit-")); dirs.push(dir); const world = join(dir, "java"); mkdirSync(world); return { dir, world }; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("rejects existing outputs, input overlap, report collisions and aliases into the input", () => {
  const { dir, world } = fixture();
  expect(() => checkedOutputPaths(world, world)).toThrow();
  expect(() => checkedOutputPaths(world, join(world, "converted.mcworld"))).toThrow(/重ならない/);
  const output = join(dir, "converted.mcworld");
  expect(() => checkedOutputPaths(world, output, output)).toThrow(/重なって/);
  writeFileSync(output, "existing");
  expect(() => checkedOutputPaths(world, output)).toThrow(/既に/);
  expect(readFileSync(output, "utf8")).toBe("existing");
  symlinkSync(world, join(dir, "alias"));
  expect(() => checkedOutputPaths(world, join(dir, "alias", "converted.mcworld"))).toThrow(/重ならない/);
});

it("packages files at the world root with Unicode paths and never overwrites an archive", () => {
  const { dir, world } = fixture();
  mkdirSync(join(world, "db"));
  writeFileSync(join(world, "level.dat"), "fixture level");
  writeFileSync(join(world, "db", "日本語.ldb"), "fixture database");
  const output = join(dir, "result.mcworld");
  packageMcworld(world, output);
  const entries = execFileSync("python3", ["-c", "import zipfile,sys,json\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))", output], { encoding: "utf8" });
  expect(JSON.parse(entries)).toEqual({ "level.dat": "fixture level", "db/日本語.ldb": "fixture database" });
  const before = readFileSync(output);
  expect(() => packageMcworld(world, output)).toThrow(/exists/);
  expect(readFileSync(output)).toEqual(before);
});

it("rejects linked world entries without leaving an archive", () => {
  const { dir, world } = fixture();
  writeFileSync(join(dir, "outside"), "outside");
  symlinkSync(join(dir, "outside"), join(world, "linked"));
  const output = join(dir, "result.mcworld");
  expect(() => packageMcworld(world, output)).toThrow();
  expect(existsSync(output)).toBe(false);
});
