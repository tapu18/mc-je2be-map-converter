import { describe, expect, it } from "vitest";
import { CommandParser, toCommandIR, type CommandTreeNode } from "./parser.ts";
import { deserializeCommandIR, serializeCommandIR } from "./ir-codec.ts";

const tree: CommandTreeNode = {type: "root", children: {
  data: {type: "literal", children: {value: {type: "argument", parser: "minecraft:nbt_compound_tag", executable: true}}},
}};
const parser = new CommandParser(tree, {textFormat: "snbt"});

describe("versioned IR", () => {
  it("round trips a long argument exactly", () => {
    const longParser = new CommandParser({type: "root", children: {probe: {type: "literal", children: {value: {type: "argument", parser: "brigadier:long", executable: true}}}}}, {textFormat: "snbt"});
    const source = "probe 9007199254740993";
    const parsed = longParser.parse(source);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const document = {grammarVersion: "26.3", textFormat: "snbt" as const, ir: toCommandIR(source, parsed.nodes)};
    expect(deserializeCommandIR(serializeCommandIR(document))).toEqual({ok: true, document});
  });
  it("round trips parsed nested NBT and all typed arrays without loss", () => {
    const source = 'data {x:5000000000L,nested:{name:"hi",list:[{x:1b},{x:2b}]},b:[B;-128b,127b],i:[I;-2147483648,2147483647],l:[L;-9223372036854775808L,9223372036854775807L]}';
    const parsed = parser.parse(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const document = {grammarVersion: "26.3", textFormat: "snbt" as const, ir: toCommandIR(source, parsed.nodes)};
    expect(deserializeCommandIR(serializeCommandIR(document))).toEqual({ok: true, document});
  });
  it("rejects unknown versions and malformed encodings", () => {
    for (const input of ['{"schemaVersion":2,"document":null}', '{', '{"schemaVersion":1,"document":["unknown"]}', '{"schemaVersion":1,"document":["int8",128]}']) {
      expect(deserializeCommandIR(input)).toMatchObject({ok: false, diagnostic: expect.any(String)});
    }
  });
});
