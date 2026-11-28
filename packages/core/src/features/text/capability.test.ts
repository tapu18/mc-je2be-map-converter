import { describe, expect, it } from "vitest";
import { CommandParser, toCommandIR, type CommandTreeNode } from "../../command/parser.ts";
import { assessText, nbtTextRuntimeReason } from "./capability.ts";
import { profileText } from "./components.ts";

const entities = { type: "entities", amount: "multiple" };
const component = { type: "argument", parser: "minecraft:component", executable: true } as const;
const tree: CommandTreeNode = { type: "root", children: {
  tellraw: { type: "literal", children: { targets: { type: "argument", parser: "minecraft:entity", properties: entities, children: { message: component } } } },
  return: { type: "literal", children: { run: { type: "literal" } } },
  title: { type: "literal", children: { targets: { type: "argument", parser: "minecraft:entity", properties: entities, children: {
    actionbar: { type: "literal", children: { title: component } },
    clear: { type: "literal", executable: true },
  } } } },
} };
const parser = new CommandParser(tree, { textFormat: "snbt" });
function parse(source: string) {
  const parsed = parser.parse(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return toCommandIR(source, parsed.nodes);
}
const profile = (source: string) => {
  const node = parse(source).command!.nodes.find(n => n.value?.kind === "text");
  if (node?.value?.kind !== "text") throw new Error("no text");
  return profileText(node.value.value);
};

describe("text components", () => {
  it("counts kinds inside extra and translation arguments, styles and extra depth", () => {
    const p = profile("tellraw @a ['',{text:'a',color:'#FF0000',bold:1b,extra:[{score:{name:'*',objective:'t'}}]},{translate:'k',with:[{selector:'@s'}]}]");
    expect([...p.kinds].sort()).toEqual(["score", "selector", "text", "translate"]);
    expect([...p.styles].sort()).toEqual(["bold", "color_hex", "with"]);
    expect(p.extraDepth).toBe(2);
    expect(profile("tellraw @a 'x'")).toMatchObject({ kinds: new Set(["text"]), extraDepth: 0 });
    expect(profile("tellraw @a {nbt:'p',storage:'a:b',interpret:1b}")).toMatchObject({ kinds: new Set(["nbt"]), nbtSources: new Set(["storage"]) });
  });

  it("keeps BE rawtext kinds native and gives nbt the runtime reason", () => {
    expect(assessText({ status: "parsed", ir: parse("title @a actionbar {score:{name:'@s',objective:'t'}}") }))
      .toMatchObject({ status: "native", requiredContext: ["executor", "scores"], value: { command: "title", display: "actionbar" } });
    expect(assessText({ status: "parsed", ir: parse("tellraw @a {nbt:'p',entity:'@s'}") }))
      .toEqual({ status: "unsupported", reason: nbtTextRuntimeReason, warnings: [], requiredContext: ["entityNbt"] });
    expect(assessText({ status: "parsed", ir: parse("tellraw @a {keybind:'key.jump'}") })).toMatchObject({ status: "unsupported", requiredContext: [] });
    expect(assessText({ status: "parsed", ir: parse("title @a clear") })).toMatchObject({ status: "unsupported" });
    expect(assessText({ status: "parsed", ir: parse("return run tellraw @a 'x'") })).toMatchObject({ status: "native", value: { command: "tellraw" } });
  });
});
