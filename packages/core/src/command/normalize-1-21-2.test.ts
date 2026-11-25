import { expect, it } from "vitest";
import { normalize1_21_2Arguments } from "./normalize-1-21-2.ts";
import type { CommandIR, ParsedNode } from "./parser.ts";

it("updates only the affected command arguments, including return run", () => {
  const arg: ParsedNode = { kind: "argument", name: "advancement", parser: "minecraft:resource_location", value: { kind: "resource", id: "minecraft:story/root", tag: false }, start: 0, end: 1 };
  const inner: CommandIR = { source: "", context: [], command: { name: "advancement", nodes: [arg] } };
  const ir: CommandIR = { source: "", context: [], command: { name: "return", nodes: [], run: inner } };
  expect(normalize1_21_2Arguments(ir).command?.run?.command?.nodes[0]?.parser).toBe("minecraft:resource_key");
  expect(arg.parser).toBe("minecraft:resource_location");
  const xp: CommandIR = { source: "", context: [], command: { name: "experience", nodes: [{ ...arg, name: "targets", parser: "minecraft:entity" }] } };
  expect(normalize1_21_2Arguments(xp).command?.nodes[0]?.name).toBe("target");
});
