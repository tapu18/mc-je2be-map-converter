import { expect, it } from "vitest";
import { normalize26_1Time } from "./normalize-26-1.ts";
import type { CommandIR } from "./parser.ts";

it("turns old fixed time literals into resource arguments in nested commands", () => {
  const inner: CommandIR = { source: "time set day", context: [], command: { name: "time", nodes: [{ kind: "literal", name: "set", start: 5, end: 8 }, { kind: "literal", name: "day", start: 9, end: 12 }] } };
  const ir: CommandIR = { source: "", context: [], command: { name: "return", nodes: [], run: inner } };
  expect(normalize26_1Time(ir).command?.run?.command?.nodes[1]).toEqual({ kind: "argument", name: "timemarker", parser: "minecraft:resource_location", value: { kind: "resource", id: "minecraft:day", tag: false }, start: 9, end: 12 });
  expect(inner.command!.nodes[1]!.kind).toBe("literal");
});
