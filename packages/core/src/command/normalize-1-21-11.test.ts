import { expect, it } from "vitest";
import { normalize1_21_11Worldborder } from "./normalize-1-21-11.ts";
import type { CommandIR } from "./parser.ts";

it("converts old worldborder seconds to ticks, including nested commands", () => {
  const inner: CommandIR = { source: "", context: [], command: { name: "worldborder", nodes: [{ kind: "argument", name: "time", parser: "brigadier:integer", value: { kind: "number", value: 7 }, start: 0, end: 1 }] } };
  const ir: CommandIR = { source: "", context: [], command: { name: "return", nodes: [], run: inner } };
  const result = normalize1_21_11Worldborder(ir);
  expect(result.ok && result.ir.command?.run?.command?.nodes[0]).toEqual({ ...inner.command!.nodes[0], parser: "minecraft:time", value: { kind: "time", ticks: 140 } });
  expect(inner.command!.nodes[0]!.value).toEqual({ kind: "number", value: 7 });
});
