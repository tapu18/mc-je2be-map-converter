import { describe, expect, it } from "vitest";
import {
  nbt,
  readBedrockLevelDat,
  readNbt,
  readNbtSequence,
  writeBedrockLevelDat,
  writeNbt,
  type NamedRoot,
} from "./nbt.ts";

const sample = (): NamedRoot => ({
  name: "root",
  tag: nbt.compound({
    b: nbt.byte(-1),
    s: nbt.short(300),
    i: nbt.int(-123456),
    l: nbt.long(-9007199254740993n),
    f: nbt.float(1.5),
    d: nbt.double(Math.PI),
    str: nbt.string("日本語 🎃 \u0000x"),
    ba: { type: "byteArray", value: Int8Array.from([1, -2, 3]) },
    ia: { type: "intArray", value: Int32Array.from([1, -2, 2147483647]) },
    la: { type: "longArray", value: BigInt64Array.from([1n, -2n]) },
    emptyList: nbt.list("end", []),
    list: nbt.list("compound", [nbt.compound({ x: nbt.int(1) }), nbt.compound({})]),
    nested: nbt.compound({ inner: nbt.compound({ deep: nbt.string("ok") }) }),
  }),
});

describe("nbt", () => {
  for (const edition of ["java", "bedrock"] as const) {
    it(`round-trips all tag types (${edition})`, () => {
      const bytes = writeNbt(sample(), edition);
      const back = readNbt(bytes, edition);
      expect(back.length).toBe(bytes.length);
      expect(back.name).toBe("root");
      expect(back.tag).toEqual(sample().tag);
      expect(writeNbt(back, edition)).toEqual(bytes);
    });
  }

  it("uses big-endian for java and little-endian for bedrock", () => {
    const root: NamedRoot = { name: "", tag: nbt.compound({ v: nbt.int(1) }) };
    // 10, name len(2), 3 (int), name len(2) "v", value
    expect(Array.from(writeNbt(root, "java"))).toEqual([10, 0, 0, 3, 0, 1, 118, 0, 0, 0, 1, 0]);
    expect(Array.from(writeNbt(root, "bedrock"))).toEqual([10, 0, 0, 3, 1, 0, 118, 1, 0, 0, 0, 0]);
  });

  it("encodes strings as modified UTF-8 (java) and UTF-8 (bedrock)", () => {
    const root: NamedRoot = { name: "", tag: nbt.compound({ s: nbt.string("\u0000🎃") }) };
    const java = writeNbt(root, "java");
    const bedrock = writeNbt(root, "bedrock");
    // java: U+0000 -> C0 80, 🎃 -> サロゲート2つで6バイト
    expect(Array.from(java.subarray(7, 7 + 8))).toEqual([0, 8, 0xc0, 0x80, 0xed, 0xa0, 0xbc, 0xed]);
    // bedrock: U+0000 -> 00, 🎃 -> 4バイト
    expect(Array.from(bedrock.subarray(7, 7 + 7))).toEqual([5, 0, 0x00, 0xf0, 0x9f, 0x8e, 0x83]);
  });

  it("reads concatenated roots", () => {
    const a = writeNbt({ name: "a", tag: nbt.compound({}) }, "bedrock");
    const b = writeNbt({ name: "b", tag: nbt.compound({ x: nbt.byte(1) }) }, "bedrock");
    const both = new Uint8Array([...a, ...b]);
    expect(readNbtSequence(both, "bedrock").map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("round-trips bedrock level.dat with header", () => {
    const dat = { storageVersion: 10, root: sample() };
    const bytes = writeBedrockLevelDat(dat);
    expect(new DataView(bytes.buffer).getInt32(4, true)).toBe(bytes.length - 8);
    expect(readBedrockLevelDat(bytes)).toEqual(dat);
  });

  it("rejects mixed list element types", () => {
    const root: NamedRoot = { name: "", tag: nbt.compound({ l: nbt.list("int", [nbt.int(1), nbt.byte(1)]) }) };
    expect(() => writeNbt(root, "java")).toThrow(/mixed/);
  });
});
