import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CommandParser, evaluatesInRuntime, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { paths } from "./paths.ts";

const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});

it.each([
  ["execute if entity @e[type=marker]", true],
  ["execute as @e at @s run scoreboard players remove @s t 1", true],
  ["execute as @e run scoreboard players add @s t 1", false],
  ["execute as @e run summon marker ~ ~ ~", false],
  ["function demo:a", true],
  ["return run function demo:a", true],
  ["return run say hi", false],
  ["return fail", true],
  ["schedule function demo:a 1t", true],
  ["data modify storage demo:a x set value 1", true],
  ["data modify entity @s x set value 1", false],
  ["setblock ~ ~ ~ stone", true],
  ["setblock ~ ~ ~ chest{Lock:\"x\"}", false],
  ["setblock ~ ~ ~ stone destroy", false],
  ["say hi", false],
] as const)("%s is evaluated by the runtime: %s", (line, expected) => {
  const parsed = parser.parse(line);
  if (!parsed.ok) throw new Error(`${line}: ${parsed.error.message}`);
  expect(evaluatesInRuntime(toCommandIR(line, parsed.nodes))).toBe(expected);
});
