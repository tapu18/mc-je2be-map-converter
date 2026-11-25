import { expect, it } from "vitest";
import { normalize26_3Schedule } from "./normalize-schedule-26-3.ts";
import type { CommandIR } from "./parser.ts";

it("diagnoses legacy schedule clear strings that cannot be resource IDs", () => {
  const ir: CommandIR = { source: "schedule clear invalid value", context: [], command: { name: "schedule", nodes: [
    { kind: "literal", name: "clear", start: 9, end: 14 },
    { kind: "argument", name: "function", parser: "brigadier:string", value: { kind: "string", value: "invalid value" }, start: 15, end: 28 },
  ] } };
  expect(normalize26_3Schedule(ir)).toMatchObject({ ok: false, start: 15, end: 28 });
});
