import { describe, expect, it } from "vitest";
import { readPackFormatRange } from "./pack-format.ts";
import { selectCommandGrammar, type CommandGrammar } from "./grammar.ts";
import { textFormatFor } from "./version.ts";
import { ARGUMENT_PARSERS } from "./arguments.ts";
import { StringReader } from "./reader.ts";

const catalog: CommandGrammar[] = [
  { version: "1.20.5", dataVersion: 3837, packFormat: 41, textFormat: "json", commandsSha256: "same" },
  { version: "1.20.6", dataVersion: 3839, packFormat: 41, textFormat: "json", commandsSha256: "same" },
  { version: "1.21.5", dataVersion: 4325, packFormat: 71, textFormat: "snbt", commandsSha256: "different" },
];

describe("versioned command grammar selection", () => {
  it("prefers the world's exact DataVersion even if a pack declares an older format", () => {
    expect(selectCommandGrammar(catalog, { dataVersion: 4325, packFormat: 41 })).toMatchObject({ ok: true, grammar: { version: "1.21.5" }, matchedBy: "data-version" });
  });
  it("uses pack_format only if its known grammars agree", () => {
    expect(selectCommandGrammar(catalog, { packFormat: 41 })).toMatchObject({ ok: true, grammar: { version: "1.20.6" }, matchedBy: "pack-format" });
    expect(selectCommandGrammar([...catalog, { ...catalog[0]!, version: "other", commandsSha256: "other" }], { packFormat: 41 })).toMatchObject({ ok: false, reason: "ambiguous" });
  });
  it("does not turn missing version coverage into a successful latest-version parse", () => {
    expect(selectCommandGrammar(catalog, { dataVersion: 3953, packFormat: 41 })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(selectCommandGrammar(catalog, {})).toMatchObject({ ok: false, reason: "unavailable" });
  });
  it("selects the release text format from DataVersion or standalone pack_format", () => {
    expect(textFormatFor(4189)).toBe("json");
    expect(textFormatFor(4325)).toBe("snbt");
    expect(textFormatFor(undefined, 61)).toBe("json");
    expect(textFormatFor(undefined, 71)).toBe("snbt");
    expect(textFormatFor(4189, 121)).toBe("json");
  });
  it("reads JSON escapes and nested values without consuming a following argument", () => {
    const reader = new StringReader(String.raw`  {"text":"a\/b","extra":[{"text":"x}y"}]} next`);
    const result = ARGUMENT_PARSERS["minecraft:component"]!(reader, undefined, { textFormat: "json" });
    expect(result.kind).toBe("text");
    if (result.kind !== "text" || result.value.type !== "compound") throw new Error("expected text compound");
    expect(result.value.value.get("text")).toEqual({ type: "string", value: "a/b" });
    expect(reader.remaining()).toBe(" next");
    expect(ARGUMENT_PARSERS["minecraft:component"]!(new StringReader("1.0"), undefined, { textFormat: "json" }))
      .toEqual({ kind: "text", format: "json", value: { type: "double", value: 1 } });
    for (const input of ["{text:'x'}", '{"text":"x",}', '{"text":"x"']) {
      expect(() => ARGUMENT_PARSERS["minecraft:component"]!(new StringReader(input), undefined, { textFormat: "json" })).toThrow();
    }
  });
});

describe("pack format ranges", () => {
  it.each([
    [{ pack: { min_format: 107, max_format: 121 } }, { min: [107, 0], max: [121, 0] }],
    [{ pack: { min_format: [107, 1], max_format: [121, 2] } }, { min: [107, 1], max: [121, 2] }],
    [{ pack: { pack_format: 41 } }, { min: [41, 0], max: [41, 0] }],
    [{ pack: { pack_format: 41, supported_formats: [41, 71] } }, { min: [41, 0], max: [71, 0] }],
    [{ pack: { supported_formats: { min_inclusive: 41, max_inclusive: 71 } } }, { min: [41, 0], max: [71, 0] }],
    [{ pack: { min_format: 71, max_format: 41 } }, undefined],
  ])("reads %j", (input, expected) => expect(readPackFormatRange(input)).toEqual(expected));
  it("selects only when all candidates agree", () => {
    expect(selectCommandGrammar(catalog, { packFormatRange: { min: [41, 0], max: [41, 0] } })).toMatchObject({ ok: true });
    expect(selectCommandGrammar(catalog, { packFormatRange: { min: [41, 0], max: [71, 0] } })).toMatchObject({ ok: false, reason: "ambiguous" });
  });
});
