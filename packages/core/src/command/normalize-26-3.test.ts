import { describe, expect, it } from "vitest";
import { normalize26_3DataArgumentNames } from "./normalize-26-3.ts";
import { CommandParser, toCommandIR, type CommandIR, type CommandTreeNode, type ParsedNode } from "./parser.ts";

const literal = (name: string): ParsedNode => ({ kind: "literal", name, start: 0, end: 1 });
const argument = (name: string): ParsedNode => ({ kind: "argument", name, parser: "minecraft:block_pos", start: 2, end: 3, value: { kind: "coordinates", coordinates: [] } });

describe("26.2 → 26.3 data argument names", () => {
  it("renames target and source without changing the original or unrelated commands", () => {
    const ir: CommandIR = { source: "test", context: [], command: { name: "data", nodes: [argument("targetPos"), argument("sourcePos")] } };
    const result = normalize26_3DataArgumentNames(ir);
    expect(result.command?.nodes.map(n => n.name)).toEqual(["target", "source"]);
    expect(ir.command?.nodes.map(n => n.name)).toEqual(["targetPos", "sourcePos"]);
    expect(normalize26_3DataArgumentNames({ ...ir, command: { name: "other", nodes: ir.command!.nodes } }).command?.nodes).toEqual(ir.command!.nodes);
  });
  it("handles execute items and nested return commands", () => {
    const ir: CommandIR = { source: "test", context: [{ kind: "if", nodes: [literal("items"), literal("block"), argument("pos")] }], command: { name: "return", nodes: [], run: { source: "test", context: [], command: { name: "function", nodes: [argument("sourcePos")] } } } };
    const result = normalize26_3DataArgumentNames(ir);
    expect(result.context[0]?.nodes[2]?.name).toBe("source");
    expect(result.command?.run?.command?.nodes[0]?.name).toBe("source");
  });
});

// 実際の版別 reports の該当経路と同じ形の小さな文法。
it("normalizes parsed data and function paths to the current grammar", () => {
  const tree = (target: string, source: string): CommandTreeNode => ({ type: "root", children: {
    data: { type: "literal", children: { modify: { type: "literal", children: { block: { type: "literal", children: {
      [target]: { type: "argument", parser: "minecraft:block_pos", children: { targetPath: { type: "argument", parser: "minecraft:nbt_path", children: {
        set: { type: "literal", children: { from: { type: "literal", children: { block: { type: "literal", children: {
          [source]: { type: "argument", parser: "minecraft:block_pos", executable: true },
        } } } } } },
      } } } },
    } } } } } },
    function: { type: "literal", children: { name: { type: "argument", parser: "minecraft:function", children: { with: { type: "literal", children: { block: { type: "literal", children: {
      [source]: { type: "argument", parser: "minecraft:block_pos", executable: true },
    } } } } } } } },
  } });
  const old = new CommandParser(tree("targetPos", "sourcePos"), { textFormat: "snbt" });
  const current = new CommandParser(tree("target", "source"), { textFormat: "snbt" });
  for (const source of ["data modify block 1 2 3 foo set from block 4 5 6", "function test:foo with block 1 2 3"]) {
    const before = old.parse(source), after = current.parse(source);
    if (!before.ok || !after.ok) throw new Error(`parse failed: ${source}`);
    expect(normalize26_3DataArgumentNames(toCommandIR(source, before.nodes))).toEqual(toCommandIR(source, after.nodes));
  }
});
