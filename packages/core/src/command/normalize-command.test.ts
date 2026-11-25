import { expect, it } from "vitest";
import { normalizeCommandIR } from "./normalize-command.ts";
import { CommandParser, toCommandIR, type CommandTreeNode } from "./parser.ts";

const literal = (children: Record<string, CommandTreeNode>): CommandTreeNode => ({ type: "literal", children });
const argument = (parser: string, children?: Record<string, CommandTreeNode>): CommandTreeNode =>
  children ? { type: "argument", parser, children } : { type: "argument", parser, executable: true };

// Java 1.21.1 と 26.3 の生成文法から、このテストで通る経路を使う。
function grammar(current: boolean): CommandTreeNode {
  return { type: "root", children: {
    execute: literal({ if: literal({ items: literal({ block: literal({
      [current ? "source" : "pos"]: argument("minecraft:block_pos", {
        slots: argument(current ? "minecraft:slot_source" : "minecraft:item_slots", {
          item_predicate: { ...argument("minecraft:item_predicate"), redirect: ["execute"] },
        }),
      }),
    }) }) }), run: { type: "literal" } }),
    time: literal({ set: literal(current ? { timemarker: argument("minecraft:resource_location") } : { noon: { type: "literal", executable: true } }) }),
    worldborder: literal({ warning: literal({ time: literal({ time: argument(current ? "minecraft:time" : "brigadier:integer") }) }) }),
    schedule: literal({ clear: literal({ function: current ? argument("minecraft:resource_location") : {
      ...argument("brigadier:string"), properties: { type: "greedy" },
    } }) }),
  } };
}

function parse(source: string, current: boolean) {
  const result = new CommandParser(grammar(current), { textFormat: current ? "snbt" : "json" }).parse(source);
  if (!result.ok) throw result.error;
  return toCommandIR(source, result.nodes);
}

it("composes the 26.1 and 26.3 boundaries on an IR parsed with the Java 1.21.1 grammar", () => {
  const command = "execute if items block 1 2 3 container.0 minecraft:stone run time set noon";
  const old = parse(command, false);
  const current = parse(command, true);
  expect(normalizeCommandIR(old, "1.21.1")).toEqual({ ok: true, ir: current });
  expect(old).not.toEqual(current);
  expect(normalizeCommandIR(current, "26.3")).toEqual({ ok: true, ir: current });
});

it("reports a legacy clear name and an overflowing border time at their original offsets", () => {
  const clear = "schedule clear foo";
  expect(normalizeCommandIR(parse(clear, false), "26.2")).toMatchObject({
    ok: false, reason: expect.stringContaining("26.2 → 26.3"), start: 15, end: clear.length,
  });
  expect(normalizeCommandIR(parse(clear, true), "26.3").ok).toBe(true);

  for (const seconds of [107374182, 107374183]) {
    const time = `worldborder warning time ${seconds}`;
    expect(normalizeCommandIR(parse(time, false), "1.21.10")).toMatchObject({
      ok: false, reason: expect.stringContaining("1.21.10 → 1.21.11"), start: 25, end: time.length,
    });
  }
  expect(normalizeCommandIR(parse("worldborder warning time 107374176", false), "1.21.10")).toMatchObject({
    ok: true, ir: { command: { nodes: [expect.anything(), expect.anything(), { value: { kind: "time", ticks: 2_147_483_520 } }] } },
  });
});
