import { expect, it } from "vitest";
import { CommandParser, type CommandTreeNode } from "@je2be/core";
import { executableShapes, executeModifiers, matchedModifiers, shapeProbes, terminalShape } from "./compatibility-inventory.ts";

it("generates numeric boundary probes without silently dropping unknown arguments", () => {
  const path: { name: string; node: CommandTreeNode }[] = [
    { name: "test", node: { type: "literal" } },
    { name: "count", node: { type: "argument", parser: "brigadier:integer", properties: { min: 1, max: 5 } } },
    { name: "enabled", node: { type: "argument", parser: "brigadier:bool" } },
  ];
  expect(shapeProbes(path)).toEqual({ commands: ["test 1 true", "test 5 true"], missing: [] });
  expect(shapeProbes([...path, { name: "x", node: { type: "argument", parser: "unknown" } }]))
    .toEqual({ commands: [], missing: ["unknown"] });
});

it("enumerates executable report nodes and joins nested commands and aliases to those keys", () => {
  const tree: CommandTreeNode = {
    type: "root", children: {
      execute: { type: "literal", children: {
        as: { type: "literal", children: { target: { type: "argument", parser: "minecraft:entity", redirect: ["execute"] } } },
        if: { type: "literal", children: { entity: { type: "literal", children: {
          target: { type: "argument", parser: "minecraft:entity", executable: true, redirect: ["execute"] },
        } } } },
        run: { type: "literal" },
      } },
      teleport: { type: "literal", children: {
        destination: { type: "argument", parser: "minecraft:vec3", executable: true },
      } },
      tp: { type: "literal", redirect: ["teleport"] },
    },
  };
  const parser = new CommandParser(tree, { textFormat: "snbt" });
  const teleport = "teleport destination<minecraft:vec3>";
  const condition = "execute if entity target<minecraft:entity>";
  expect([...executableShapes(tree).keys()]).toEqual([condition, teleport]);

  expect([...executeModifiers(tree).keys()]).toEqual(["execute as target<minecraft:entity>", condition]);
  const repeated = parser.parse("execute as @s as @p run tp 1 2 3");
  if (!repeated.ok) throw new Error(repeated.error.message);
  expect(matchedModifiers(tree, repeated.nodes)).toEqual(["execute as target<minecraft:entity>"]);

  for (const [command, expected] of [
    ["tp 1 2 3", teleport],
    ["execute as @s if entity @p", condition],
    ["execute as @s if entity @p run execute as @s run tp 4 5 6", teleport],
  ]) {
    const result = parser.parse(command!);
    if (!result.ok) throw new Error(result.error.message);
    expect(terminalShape(tree, result.nodes)).toBe(expected);
  }
});

// The generated ledger must contain every modifier from the fixed report.
it("includes every fixed grammar execute redirect in the generated inventory", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const report = "servers/reports-26.3/reports/commands.json";
  if (!existsSync(report)) return; // CI may run without server resources.
  const tree = JSON.parse(readFileSync(report, "utf8")) as CommandTreeNode;
  const expected: string[] = [];
  function visit(node: CommandTreeNode, path: string[]): void {
    if (node.redirect?.length === 1 && node.redirect[0] === "execute") expected.push(path.join(" "));
    for (const [name, child] of Object.entries(node.children ?? {})) visit(child, [...path, child.parser ? `${name}<${child.parser}>` : name]);
  }
  for (const [name, child] of Object.entries(tree.children!.execute!.children ?? {})) visit(child, ["execute", child.parser ? `${name}<${child.parser}>` : name]);
  const ledger = readFileSync("docs/compatibility.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line) as { family: string; id: string });
  const ids = new Set(ledger.filter(row => row.family === "command").map(row => row.id));
  expect(executeModifiers(tree).size).toBe(expected.length);
  expect(expected.filter(id => ids.has(id))).toHaveLength(expected.length);
});
