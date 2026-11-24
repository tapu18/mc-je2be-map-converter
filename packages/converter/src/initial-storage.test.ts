import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deserializeStorage, nbt, writeNbt } from "@je2be/core";
import { collectInitialStorage, writeInitPack } from "./convert.ts";
import { JavaWorld } from "./java-world.ts";

describe("initial storage", () => {
  it("splits UTF-8 payloads and restores typed values, reporting unreadable files", () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    try {
      writeFileSync(join(dir, "level.dat"), "");
      mkdirSync(join(dir, "data"));
      const value = nbt.compound(new Map([["text", nbt.string("😀".repeat(9000))], ["long", nbt.long(9223372036854775807n)], ["array", { type: "longArray", value: new BigInt64Array([-9223372036854775808n, 9007199254740993n]) }]]));
      const root = nbt.compound(new Map([["data", nbt.compound(new Map([["contents", nbt.compound(new Map([["large", value]]))]]))]]));
      writeFileSync(join(dir, "data", "command_storage_test.dat"), gzipSync(writeNbt({name: "", tag: root}, "java")));
      writeFileSync(join(dir, "data", "command_storage_bad.dat"), "bad");
      const result = collectInitialStorage(new JavaWorld(dir));
      expect(result.storageErrors).toHaveLength(1);
      const entry = result.storageEntries[0]!;
      expect(entry.id).toBe("test:large");
      expect(entry.chunks.length).toBeGreaterThan(1);
      expect(entry.chunks.every(chunk => Buffer.byteLength(chunk) <= 32767)).toBe(true);
      expect(deserializeStorage(entry.chunks.join(""))).toEqual(value);
      writeInitPack(dir, [], [], "", JSON.stringify(result.storageEntries));
      const script = readFileSync(join(dir, "behavior_packs/je2be_init/scripts/storage.js"), "utf8");
      expect(JSON.parse(script.slice("export const storage = ".length, -2))).toEqual(result.storageEntries);
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
});
