import { describe, expect, it } from "vitest";
import { CommandParser, toCommandIR, type CommandTreeNode } from "../../command/parser.ts";
import { assessSound } from "./capability.ts";

const tree: CommandTreeNode = { type: "root", children: {
  playsound: { type: "literal", children: {
    sound: { type: "argument", parser: "minecraft:resource_location", executable: true, children: {
      master: { type: "literal", executable: true },
    } },
  } },
} };
const parser = new CommandParser(tree, { textFormat: "json" });
const mapping = (id: string) => id === "minecraft:test" ? "be.test" : undefined;
function assess(source: string) {
  const parsed = parser.parse(source);
  return assessSound(parsed.ok ? { status: "parsed", ir: toCommandIR(source, parsed.nodes) } :
    { status: "invalid", message: parsed.error.message, position: parsed.error.position }, mapping);
}

describe("sound capability", () => {
  it("preserves parser errors as invalid, separately from unsupported IDs", () => {
    expect(assess("playsound")).toMatchObject({ status: "invalid", reason: expect.any(String), position: expect.any(Number), warnings: [], requiredContext: [] });
    expect(assess("playsound missing master")).toMatchObject({ status: "unsupported", reason: "BE に対応のないサウンド minecraft:missing", warnings: [] });
  });
  it("returns the mapped plan, required context and ordered warnings", () => {
    expect(assess("playsound test master")).toMatchObject({ status: "native", requiredContext: ["position"], value: { id: "be.test", hasPosition: false }, warnings: [expect.stringContaining("master"), expect.stringContaining("音量")] });
  });
});
