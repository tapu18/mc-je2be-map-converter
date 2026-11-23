import { expect, it } from "vitest";
import { CommandParser, type CommandTreeNode } from "./parser.ts";
import { probeMacroTemplate } from "./macro-template.ts";

const tree: CommandTreeNode = { type: "root", children: { say: { type: "literal", children: { message: { type: "argument", parser: "minecraft:message", executable: true } } } } };
const parser = new CommandParser(tree, { textFormat: "json" });

it("maps repeated holes inside an argument back to the template", () => {
  const result = probeMacroTemplate(parser, "$say hello-$(a)-$(a)", "x");
  expect(result?.holes).toEqual([
    { name: "a", start: 11, end: 15, argument: "message", parser: "minecraft:message", offset: 6 },
    { name: "a", start: 16, end: 20, argument: "message", parser: "minecraft:message", offset: 8 },
  ]);
});

it("does not claim that a hole in a command literal is an argument", () => {
  expect(probeMacroTemplate(parser, "$$(command) hello", "say")).toBeUndefined();
});
