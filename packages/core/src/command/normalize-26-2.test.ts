import { expect, it } from "vitest";
import { normalize26_2TeamColor } from "./normalize-26-2.ts";
import type { CommandIR, ParsedNode } from "./parser.ts";

it("updates only team and waypoint color arguments, including nested commands", () => {
  const color: ParsedNode = { kind: "argument", name: "value", parser: "minecraft:color", start: 0, end: 3, value: { kind: "word", value: "red" } };
  const nested: CommandIR = { source: "", context: [], command: { name: "team", nodes: [color] } };
  const ir: CommandIR = { source: "", context: [], command: { name: "return", nodes: [color], run: nested } };
  const result = normalize26_2TeamColor(ir);
  expect(result.command?.nodes[0]).toEqual(color);
  expect(result.command?.run?.command?.nodes[0]).toEqual({ ...color, parser: "minecraft:team_color" });
  expect(nested.command?.nodes[0]).toEqual(color);
});
