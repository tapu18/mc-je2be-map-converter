import { describe, expect, it } from "vitest";
import { CommandParser, toCommandIR, type CommandTreeNode, type ParsedNode } from "./parser.ts";

// commands.json と同じ形の小さな木（本物はデータ生成で作るため、Node のテストでは使わない）。
// 形は 26.3 の commands.json の該当箇所に合わせた
const arg = (parser: string, extra: Partial<CommandTreeNode> = {}): CommandTreeNode => ({ type: "argument", parser, ...extra });
const lit = (extra: Partial<CommandTreeNode> = {}): CommandTreeNode => ({ type: "literal", ...extra });
const entities = { type: "entities", amount: "multiple" };
const executeTail: Partial<CommandTreeNode> = { redirect: ["execute"] };

const tree: CommandTreeNode = {
  type: "root",
  children: {
    say: lit({ children: { message: arg("minecraft:message", { executable: true }) } }),
    kill: lit({ executable: true, children: { targets: arg("minecraft:entity", { executable: true, properties: entities }) } }),
    tellraw: lit({
      children: {
        targets: arg("minecraft:entity", {
          properties: { type: "players", amount: "multiple" },
          children: { message: arg("minecraft:component", { executable: true }) },
        }),
      },
    }),
    setblock: lit({
      children: { pos: arg("minecraft:block_pos", { children: { block: arg("minecraft:block_state", { executable: true }) } }) },
    }),
    give: lit({
      children: {
        targets: arg("minecraft:entity", {
          properties: { type: "players", amount: "multiple" },
          children: {
            item: arg("minecraft:item_stack", {
              executable: true,
              children: { count: arg("brigadier:integer", { executable: true, properties: { min: 1 } }) },
            }),
          },
        }),
      },
    }),
    scoreboard: lit({
      children: {
        players: lit({
          children: {
            set: lit({
              children: {
                targets: arg("minecraft:score_holder", {
                  properties: { amount: "multiple" },
                  children: { objective: arg("minecraft:objective", { children: { score: arg("brigadier:integer", { executable: true }) } }) },
                }),
              },
            }),
            operation: lit({
              children: {
                targets: arg("minecraft:score_holder", {
                  children: {
                    targetObjective: arg("minecraft:objective", {
                      children: {
                        operation: arg("minecraft:operation", {
                          children: {
                            source: arg("minecraft:score_holder", {
                              children: { sourceObjective: arg("minecraft:objective", { executable: true }) },
                            }),
                          },
                        }),
                      },
                    }),
                  },
                }),
              },
            }),
          },
        }),
      },
    }),
    data: lit({
      children: {
        get: lit({
          children: {
            storage: lit({
              children: {
                source: arg("minecraft:resource_location", {
                  executable: true,
                  children: { path: arg("minecraft:nbt_path", { executable: true }) },
                }),
              },
            }),
          },
        }),
      },
    }),
    execute: lit({
      children: {
        as: lit({ children: { targets: arg("minecraft:entity", { properties: entities, ...executeTail }) } }),
        at: lit({ children: { targets: arg("minecraft:entity", { properties: entities, ...executeTail }) } }),
        positioned: lit({ children: { pos: arg("minecraft:vec3", executeTail) } }),
        if: lit({
          children: {
            score: lit({
              children: {
                target: arg("minecraft:score_holder", {
                  properties: { amount: "single" },
                  children: {
                    targetObjective: arg("minecraft:objective", {
                      children: { matches: lit({ children: { range: arg("minecraft:int_range", { executable: true, ...executeTail }) } }) },
                    }),
                  },
                }),
              },
            }),
            entity: lit({ children: { entities: arg("minecraft:entity", { executable: true, properties: entities, ...executeTail }) } }),
          },
        }),
        run: lit(),
      },
    }),
    tp: lit({ redirect: ["teleport"] }),
    teleport: lit({
      children: {
        location: arg("minecraft:vec3", { executable: true }),
        targets: arg("minecraft:entity", { properties: entities, children: { location: arg("minecraft:vec3", { executable: true }) } }),
      },
    }),
  },
};

const parser = new CommandParser(tree, { textFormat: "snbt" });

function parseOk(cmd: string): ParsedNode[] {
  const r = parser.parse(cmd);
  if (!r.ok) throw new Error(`${cmd}: ${r.error.message} @${r.error.position}`);
  return r.nodes;
}
const names = (nodes: ParsedNode[]): string[] => nodes.map((n) => n.name);

describe("CommandParser", () => {
  it("リテラルと引数をたどる", () => {
    const nodes = parseOk("scoreboard players set @s obj -5");
    expect(names(nodes)).toEqual(["scoreboard", "players", "set", "targets", "objective", "score"]);
    expect(nodes[5]?.value).toEqual({ kind: "number", value: -5 });
    expect(nodes[3]).toMatchObject({ start: 23, end: 25 });
  });

  it("先頭の / を取り除き、位置は元の文字列で返す", () => {
    const nodes = parseOk("/kill @e");
    expect(nodes[1]).toMatchObject({ start: 6, end: 8 });
  });

  it("実行できない節で終わると失敗する", () => {
    const r = parser.parse("scoreboard players set @s obj");
    expect(r.ok).toBe(false);
  });

  it("引数の後ろに余分な文字があると失敗する", () => {
    const r = parser.parse("give @p diamond_sword{Damage:1}");
    expect(r).toMatchObject({ ok: false, error: { parser: "minecraft:item_stack" } });
  });

  it("引数の範囲（properties の min）を確かめる", () => {
    expect(parser.parse("give @p stone 0").ok).toBe(false);
    expect(parser.parse("give @p stone 1").ok).toBe(true);
  });

  it("失敗の位置は、最も先まで読めた候補のものを返す", () => {
    const r = parser.parse("scoreboard players operation @s a ** @s b");
    expect(r).toMatchObject({ ok: false, error: { position: 34, parser: "minecraft:operation" } });
  });

  it("redirect（tp → teleport）をたどる", () => {
    expect(names(parseOk("tp @s ~ ~1 ~"))).toEqual(["tp", "targets", "location"]);
    expect(names(parseOk("tp ~ ~1 ~"))).toEqual(["tp", "location"]);
  });

  it("文法にないコマンドは失敗する", () => {
    expect(parser.parse("中身は空のようだ")).toMatchObject({ ok: false, error: { position: 0 } });
    expect(parser.parse("")).toMatchObject({ ok: false });
  });

  it("パスが空の ID（storage ns:）を読む", () => {
    const nodes = parseOk("data get storage ns: a.[0]");
    expect(nodes[3]?.value).toEqual({ kind: "resource", id: "ns:", tag: false });
    expect(nodes[4]?.value).toEqual({ kind: "nbtPath", path: [{ kind: "key", key: "a" }, { kind: "index", index: 0 }] });
  });
});

describe("toCommandIR", () => {
  it("execute のサブコマンドを並べ、run の先を最後のコマンドにする", () => {
    const cmd = "execute as @a at @s positioned ~ ~1 ~ if score @s a matches 1.. run say hi";
    const ir = toCommandIR(cmd, parseOk(cmd));
    expect(ir.context.map((s) => s.kind)).toEqual(["as", "at", "positioned", "if"]);
    expect(ir.context[3]?.nodes.map((n) => n.name)).toEqual(["score", "target", "targetObjective", "matches", "range"]);
    expect(ir.context[2]?.nodes[0]?.value).toEqual({
      kind: "coordinates",
      coordinates: [
        { kind: "relative", value: 0 },
        { kind: "relative", value: 1 },
        { kind: "relative", value: 0 },
      ],
    });
    expect(ir.command?.name).toBe("say");
    expect(ir.command?.nodes[0]?.value).toEqual({ kind: "string", value: "hi" });
  });

  it("入れ子の execute ... run execute も平らにする", () => {
    const cmd = "execute as @a run execute at @s run kill @s";
    const ir = toCommandIR(cmd, parseOk(cmd));
    expect(ir.context.map((s) => s.kind)).toEqual(["as", "at"]);
    expect(ir.command?.name).toBe("kill");
  });

  it("run なしで終わる execute は、最後のコマンドを持たない", () => {
    const cmd = "execute if entity @e[type=pig]";
    const ir = toCommandIR(cmd, parseOk(cmd));
    expect(ir.context.map((s) => s.kind)).toEqual(["if"]);
    expect(ir.command).toBeUndefined();
  });

  it("execute でないコマンドは、そのまま最後のコマンドになる", () => {
    const ir = toCommandIR("kill @s", parseOk("kill @s"));
    expect(ir).toMatchObject({ context: [], command: { name: "kill" } });
  });
});

describe("引数", () => {
  it("セレクタの引数（否定、範囲、scores、nbt）", () => {
    const nodes = parseOk("kill @e[ type = !minecraft:pig , distance=..5, scores={a=1..,b=..3}, nbt=!{OnGround:1b}, tag=]");
    const v = nodes[1]?.value;
    expect(v?.kind).toBe("selector");
    if (v?.kind !== "selector") return;
    expect(v.selector.variable).toBe("e");
    expect(v.selector.arguments.map((a) => [a.key, a.negated])).toEqual([
      ["type", true],
      ["distance", false],
      ["scores", false],
      ["nbt", true],
      ["tag", false],
    ]);
    expect(v.selector.arguments[1]?.value).toEqual({ kind: "range", range: { max: 5 } });
    expect(v.selector.arguments[2]?.value).toEqual({ kind: "scores", scores: { a: { min: 1 }, b: { max: 3 } } });
  });

  it("否定できないセレクタ引数と、limit=0 は失敗する", () => {
    expect(parser.parse("kill @e[limit=!1]").ok).toBe(false);
    expect(parser.parse("kill @e[limit=0]").ok).toBe(false);
    expect(parser.parse("kill @e[x=~1]").ok).toBe(false);
  });

  it("座標：ブロック座標の絶対値は整数、^ と他は混ぜられない", () => {
    expect(parser.parse("setblock 1.5 2 3 stone").ok).toBe(false);
    expect(parser.parse("setblock ~0.5 ~ ~ stone").ok).toBe(true);
    expect(parser.parse("tp @s ^ ~ ^").ok).toBe(false);
    expect(parser.parse("tp @s ~~1~").ok).toBe(false);
  });

  it("ブロックの状態と NBT", () => {
    const nodes = parseOk("setblock 1 2 3 oak_stairs[facing=east,half=top]{a:1}");
    expect(nodes[2]?.value).toMatchObject({ kind: "block", id: "minecraft:oak_stairs", tag: false, states: { facing: "east", half: "top" } });
    expect(parser.parse("setblock 1 2 3 #minecraft:logs").ok).toBe(false);
  });

  it("アイテムのデータコンポーネント", () => {
    const nodes = parseOk("give @p diamond_sword[enchantments={sharpness:5},!minecraft:damage] 2");
    expect(nodes[2]?.value).toMatchObject({
      kind: "item",
      id: "minecraft:diamond_sword",
      components: [
        { removed: false, key: "minecraft:enchantments" },
        { removed: true, key: "minecraft:damage" },
      ],
    });
  });

  it("テキストは書き方（JSON / SNBT）を付けて返す", () => {
    const json = new CommandParser(tree, { textFormat: "json" }).parse('tellraw @a ["",{"text":"a"}]');
    expect(json.ok && json.nodes[2]?.value).toMatchObject({ kind: "text", format: "json", value: { type: "list" } });
    const snbt = parseOk('tellraw @a {text:"a",color:"red"}');
    expect(snbt[2]?.value).toMatchObject({ kind: "text", format: "snbt", value: { type: "compound" } });
  });

  it("スコアの保持者（*、# 始まりの名前）", () => {
    expect(parseOk("scoreboard players set * obj 1")[3]?.value).toEqual({ kind: "name", value: "*" });
    expect(parseOk("scoreboard players set #fake obj 1")[3]?.value).toEqual({ kind: "name", value: "#fake" });
  });
});

it("#205: 合成 long 文法では安全整数を超える値が丸められる現状を再現する", () => {
  const parser = new CommandParser({ type: "root", children: { probe: lit({ children: { value: arg("brigadier:long", { executable: true }) } }) } }, { textFormat: "snbt" });
  const result = parser.parse("probe 9007199254740993");
  expect(result.ok && result.nodes[1]?.value).toEqual({ kind: "number", value: 9007199254740992 });
});
