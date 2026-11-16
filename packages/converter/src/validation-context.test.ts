import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { writeNbt, type NbtTag } from "@je2be/core";
import { afterEach, expect, it } from "vitest";
import { readJavaValidationContext } from "./validation-context.ts";

const directories: string[] = [];
function world(enabled: string[], disabled: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "je2be-context-test-")); directories.push(dir);
  const strings = (values: string[]): NbtTag => ({ type: "list", elementType: "string", value: values.map((value) => ({ type: "string", value })) });
  const compound = (entries: [string, NbtTag][]): NbtTag & { type: "compound" } => ({ type: "compound", value: new Map(entries) });
  writeFileSync(join(dir, "level.dat"), gzipSync(writeNbt({ name: "", tag: compound([["Data", compound([
    ["DataVersion", { type: "int", value: 3839 }],
    ["DataPacks", compound([["Enabled", strings(enabled)], ["Disabled", strings(disabled)]])],
  ])]]) }, "java")));
  mkdirSync(join(dir, "datapacks", "first"), { recursive: true });
  writeFileSync(join(dir, "datapacks", "second.zip"), "ZIP is checked when copied");
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("preserves saved enabled order and builtins while excluding disabled or unselected packs", () => {
  const dir = world(["file/second.zip", "vanilla", "file/first"], ["file/disabled"]);
  expect(readJavaValidationContext(dir)).toEqual({
    world: dir, dataVersion: 3839, enabled: ["file/second.zip", "vanilla", "file/first"], disabled: ["file/disabled"],
    datapacks: [join(dir, "datapacks", "second.zip"), join(dir, "datapacks", "first")],
    packOrder: [{ datapack: 0 }, { builtin: "vanilla" }, { datapack: 1 }],
  });
});

it("fails explicitly for missing enabled packs and inconsistent saved lists", () => {
  expect(() => readJavaValidationContext(world(["vanilla", "file/missing"], []))).toThrow();
  expect(() => readJavaValidationContext(world(["file/first"], ["file/first"])) ).toThrow(/inconsistent/);
  expect(() => readJavaValidationContext(world(["file/../outside"], []))).toThrow(/invalid/);
});
