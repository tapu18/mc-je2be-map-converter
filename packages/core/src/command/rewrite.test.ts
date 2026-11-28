import { describe, expect, it } from "vitest";
import type { NbtTag } from "../nbt/nbt.ts";
import { MappingLookup, type MappingTables } from "../mappings/mappings.ts";
import { readSelector } from "./arguments.ts";
import { CommandParser, type CommandTreeNode } from "./parser.ts";
import { toRawText } from "../features/text/rawtext.ts";
import { StringReader } from "./reader.ts";
import { rewriteCommand, rewriteSelector, type RewriteContext } from "./rewrite.ts";
import { readSnbtValue } from "./snbt.ts";

const sel = (s: string) => rewriteSelector(readSelector(new StringReader(s)));
const text = (snbt: string): NbtTag => readSnbtValue(new StringReader(snbt));
const raw = (snbt: string) => toRawText(text(snbt), { selector: (s) => ({ ok: true, value: `<${s}>` }) });

describe("selector rewrite", () => {
  it("maps distance, limit/sort, level, gamemode and rotations to BE arguments", () => {
    expect(sel("@e[type=minecraft:armor_stand,distance=..3,limit=1,sort=nearest,tag=a]")).toEqual({ ok: true, value: "@e[type=armor_stand,r=3,tag=a,c=1]", warnings: [] });
    expect(sel("@e[distance=2..5.5,sort=furthest,limit=2]")).toMatchObject({ value: "@e[rm=2,r=5.5,c=-2]" });
    expect(sel("@a[level=3..,gamemode=!creative,x_rotation=-10..10,y_rotation=..90]")).toMatchObject({ value: "@a[lm=3,m=!creative,rxm=-10,rx=10,ry=90]" });
    expect(sel("@a[x=1,y=2,z=3,dx=4,dy=0,dz=5,scores={t=1..,u=..-1,v=3}]")).toMatchObject({ value: "@a[x=1,y=2,z=3,dx=4,dy=0,dz=5,scores={t=1..,u=..-1,v=3}]" });
    expect(sel('@e[name="a b",tag=!x,type=!minecraft:pig]')).toMatchObject({ value: '@e[name="a b",tag=!x,type=!pig]' });
    expect(sel("@n[tag=t]")).toMatchObject({ value: "@e[tag=t,c=1]", warnings: [] });
    expect(sel("@s")).toMatchObject({ value: "@s" });
  });

  it("warns when the choice or order can change, and refuses what BE cannot select", () => {
    expect(sel("@e[limit=2]")).toMatchObject({ ok: true, value: "@e[c=2]", warnings: [expect.stringContaining("近い順")] });
    expect(sel("@e[sort=nearest]")).toMatchObject({ ok: true, value: "@e", warnings: [expect.stringContaining("sort=nearest")] });
    expect(sel("@r[limit=2,sort=random]")).toMatchObject({ value: "@r[c=2]", warnings: [] });
    expect(sel("@e[limit=1,sort=random]")).toMatchObject({ ok: false });
    expect(sel("@e[team=red]")).toMatchObject({ ok: false });
    expect(sel("@e[nbt={a:1b}]")).toMatchObject({ ok: false, message: expect.stringContaining("ランタイム") });
    expect(sel("@e[type=minecraft:marker]")).toMatchObject({ ok: false });
    expect(sel("@e[type=#minecraft:skeletons]")).toMatchObject({ ok: false });
  });
});

describe("text to rawtext", () => {
  it("flattens strings, lists, extra, score and selector with § styles", () => {
    expect(raw('"hi"').rawtext).toEqual({ rawtext: [{ text: "hi" }] });
    expect(raw('[{"text":"A","color":"red"},"B",{"text":"C","bold":true}]').rawtext).toEqual({ rawtext: [{ text: "§cAB§r§c§lC" }] });
    expect(raw('{"text":"","extra":[{"score":{"name":"*","objective":"t"},"color":"gold"},{"selector":"@p"}]}').rawtext).toEqual({
      rawtext: [{ text: "§6" }, { score: { name: "*", objective: "t" } }, { text: "§r" }, { selector: "<@p>" }],
    });
    // SNBT の書き方（1.21.5 以降）でも同じ
    expect(raw("{text:'x',italic:1b,extra:[{text:'y',italic:false}]}").rawtext).toEqual({ rawtext: [{ text: "§ox§ry" }] });
  });

  it("keeps translations with arguments and reports dropped or unsupported parts", () => {
    const t = raw('{"translate":"chat.type.text","with":["a",{"text":"b","color":"blue"}]}');
    expect(t.rawtext).toEqual({ rawtext: [{ translate: "chat.type.text", with: { rawtext: [{ text: "a" }, { text: "§9b" }] } }] });
    expect(t.issues).toEqual([{ severity: "warning", message: expect.stringContaining("翻訳キー") }]);
    expect(raw('{"text":"x","click_event":{"action":"run_command","command":"/say"}}').issues).toEqual([{ severity: "warning", message: expect.stringContaining("click_event") }]);
    expect(raw('{"text":"x","color":"#FF5050"}')).toMatchObject({ rawtext: { rawtext: [{ text: "§cx" }] }, issues: [{ severity: "warning" }] });
    expect(raw('{"nbt":"a","storage":"x:y"}').issues).toEqual([{ severity: "unsupported", message: expect.stringContaining("nbt") }]);
    expect(raw('{"keybind":"key.jump"}').issues[0]?.severity).toBe("unsupported");
  });
});

// commands.json と同じ形の小さな木（本物は Mojang のデータのため、Node のテストでは使わない。実物での確認は rewrite.servers.test.ts）
const arg = (parser: string, extra: Partial<CommandTreeNode> = {}): CommandTreeNode => ({ type: "argument", parser, ...extra });
const lit = (extra: Partial<CommandTreeNode> = {}): CommandTreeNode => ({ type: "literal", ...extra });
const entities = { type: "entities", amount: "multiple" };
const tail: Partial<CommandTreeNode> = { redirect: ["execute"] };
const tree: CommandTreeNode = {
  type: "root",
  children: {
    say: lit({ children: { message: arg("minecraft:message", { executable: true }) } }),
    kill: lit({ executable: true, children: { targets: arg("minecraft:entity", { executable: true, properties: entities }) } }),
    tag: lit({ children: { targets: arg("minecraft:entity", { properties: entities, children: {
      add: lit({ children: { name: arg("brigadier:string", { executable: true, properties: { type: "word" } }) } }),
      remove: lit({ children: { name: arg("brigadier:string", { executable: true, properties: { type: "word" } }) } }),
    } }) } }),
    tp: lit({ redirect: ["teleport"] }),
    teleport: lit({ children: { targets: arg("minecraft:entity", { properties: entities, children: {
      destination: arg("minecraft:entity", { executable: true, properties: { type: "entities", amount: "single" } }),
      location: arg("minecraft:vec3", { executable: true, children: {
        rotation: arg("minecraft:rotation", { executable: true }),
        facing: lit({ children: {
          entity: lit({ children: { facingEntity: arg("minecraft:entity", { executable: true, properties: { type: "entities", amount: "single" }, children: {
            facingAnchor: arg("minecraft:entity_anchor", { executable: true }),
          } }) } }),
          facingLocation: arg("minecraft:vec3", { executable: true }),
        } }),
      } }),
    } }) } }),
    tellraw: lit({ children: { targets: arg("minecraft:entity", { children: { message: arg("minecraft:component", { executable: true }) } }) } }),
    title: lit({
      children: {
        targets: arg("minecraft:entity", {
          children: {
            title: lit({ children: { title: arg("minecraft:component", { executable: true }) } }),
            times: lit({ children: { fadeIn: arg("minecraft:time", { children: { stay: arg("minecraft:time", { children: { fadeOut: arg("minecraft:time", { executable: true }) } }) } }) } }),
          },
        }),
      },
    }),
    setblock: lit({ children: { pos: arg("minecraft:block_pos", { children: { block: arg("minecraft:block_state", { executable: true, children: { strict: lit({ executable: true }) } }) } }) } }),
    give: lit({
      children: {
        targets: arg("minecraft:entity", { children: { item: arg("minecraft:item_stack", { executable: true, children: { count: arg("brigadier:integer", { executable: true }) } }) } }),
      },
    }),
    scoreboard: lit({
      children: {
        objectives: lit({
          children: {
            add: lit({ children: { objective: arg("brigadier:string", { children: { criteria: arg("minecraft:objective_criteria", { executable: true, children: { displayName: arg("minecraft:component", { executable: true }) } }) } }) } }),
          },
        }),
      },
    }),
    execute: lit({
      children: {
        as: lit({ children: { targets: arg("minecraft:entity", { properties: entities, ...tail }) } }),
        in: lit({ children: { dimension: arg("minecraft:dimension", tail) } }),
        if: lit({ children: { block: lit({ children: { pos: arg("minecraft:block_pos", { children: { block: arg("minecraft:block_predicate", { executable: true, ...tail }) } }) } }) } }),
        store: lit({ children: { result: lit({ children: { score: lit({ children: { targets: arg("minecraft:score_holder", { children: { objective: arg("minecraft:objective", tail) } }) } }) } }) } }),
        run: lit(),
      },
    }),
    data: lit({ children: { get: lit({ children: { storage: lit({ children: { source: arg("minecraft:resource_location", { executable: true }) } }) } }) } }),
  },
};

const tables: MappingTables = {
  schemaVersion: 1,
  source: { repository: "test", revision: "test", javaVersion: "test", bedrockVersion: "test", sha256: {} },
  blocks: [
    { java: { id: "minecraft:stone", states: {} }, bedrock: { id: "minecraft:stone", states: {} } },
    ...["east", "west"].flatMap((facing, d) =>
      ["false", "true"].map((waterlogged) => ({
        java: { id: "minecraft:oak_stairs", states: { facing, waterlogged } },
        bedrock: { id: "minecraft:oak_stairs", states: { weirdo_direction: d } },
      })),
    ),
  ],
  items: [{ javaId: "minecraft:stone", bedrockId: "minecraft:stone" }, { javaId: "minecraft:white_wool", bedrockId: "minecraft:wool", data: 0 }, { javaId: "minecraft:red_wool", bedrockId: "minecraft:wool", data: 14 }],
};

describe("command rewrite", () => {
  const ctx: RewriteContext = {
    parser: new CommandParser(tree, { textFormat: "json" }),
    mappings: new MappingLookup(tables),
    blockDefaults: (id) => (id === "minecraft:oak_stairs" ? { facing: "east", waterlogged: "false" } : undefined),
  };
  const rw = (c: string) => rewriteCommand(c, ctx);

  it("rewrites only the parts that differ and keeps the rest of the text", () => {
    expect(rw("/kill @e[type=minecraft:pig,distance=..5]")).toEqual({ status: "rewritten", command: "kill @e[type=pig,r=5]", issues: [] });
    expect(rw("kill @s")).toEqual({ status: "unchanged", command: "kill @s", issues: [] });
    expect(rw("say hi @e[distance=..2] and @alice")).toMatchObject({ command: "say hi @e[r=2] and @alice" });
    expect(rw('tellraw @a {"text":"x","color":"red"}')).toMatchObject({ command: 'tellraw @a {"rawtext":[{"text":"§cx"}]}' });
    expect(rw('title @a title "Hi"')).toMatchObject({ command: 'titleraw @a title {"rawtext":[{"text":"Hi"}]}' });
    expect(rw("title @a times 1s 2 0.5s")).toMatchObject({ command: "title @a times 20 2 10" });
  });

  it("maps blocks with Java defaults, block predicates, items and dimensions", () => {
    expect(rw("setblock 1 2 3 minecraft:oak_stairs[facing=west]")).toMatchObject({ command: 'setblock 1 2 3 minecraft:oak_stairs ["weirdo_direction"=1]' });
    expect(rw("setblock 1 2 3 oak_stairs")).toMatchObject({ command: 'setblock 1 2 3 minecraft:oak_stairs ["weirdo_direction"=0]' });
    expect(rw("setblock 1 2 3 oak_stairs[waterlogged=true]")).toMatchObject({ status: "rewritten", issues: [{ severity: "warning", message: expect.stringContaining("水没") }] });
    expect(rw("execute if block ~ ~ ~ oak_stairs[facing=west] run kill @s")).toMatchObject({ command: 'execute if block ~ ~ ~ minecraft:oak_stairs ["weirdo_direction"=1] run kill @s' });
    expect(rw("execute if block ~ ~ ~ oak_stairs[waterlogged=true] run kill @s")).toMatchObject({ status: "unsupported" });
    expect(rw("execute in minecraft:the_nether run kill @s")).toMatchObject({ command: "execute in nether run kill @s" });
    expect(rw("give @a minecraft:red_wool 3")).toMatchObject({ command: "give @a minecraft:wool 3 14" });
    expect(rw("give @a minecraft:white_wool")).toMatchObject({ command: "give @a minecraft:wool" });
    expect(rw("give @a stone 2")).toMatchObject({ status: "unchanged", command: "give @a stone 2" });
    expect(rw("scoreboard objectives add t dummy {\"text\":\"Time\"}")).toMatchObject({ command: 'scoreboard objectives add t dummy "Time"' });
    expect(rw('scoreboard objectives add t dummy {"text":"Time","color":"red"}')).toMatchObject({ command: "scoreboard objectives add t dummy", issues: [{ severity: "warning" }] });
  });

  it("keeps kill, tag and teleport, and drops entity and feet from tp facing entity (features/entity)", () => {
    expect(rw("tag @e[tag=a] add b")).toMatchObject({ status: "unchanged" });
    expect(rw("tag @e[tag=a] remove b")).toMatchObject({ status: "unchanged" });
    expect(rw("tp @e[tag=a] ~1 ~ ~ ~45 ~10")).toMatchObject({ status: "unchanged" });
    expect(rw("teleport @e[tag=a] @e[tag=b,limit=1]")).toMatchObject({ command: "teleport @e[tag=a] @e[tag=b,c=1]" });
    expect(rw("tp @e[tag=a] 1 2 3 facing 4 5 6")).toMatchObject({ status: "unchanged" });
    expect(rw("tp @e[tag=a] 1 2 3 facing entity @e[tag=b,limit=1]")).toMatchObject({ status: "rewritten", command: "tp @e[tag=a] 1 2 3 facing @e[tag=b,c=1]" });
    expect(rw("teleport @s 1 2 3 facing entity @e[tag=b,limit=1] feet")).toMatchObject({ command: "teleport @s 1 2 3 facing @e[tag=b,c=1]" });
    expect(rw("tp @s 1 2 3 facing entity @e[tag=b,limit=1] eyes")).toMatchObject({ status: "unsupported", issues: [{ message: expect.stringContaining("eyes") }] });
  });

  it("reports commands that need the runtime or have no BE form", () => {
    expect(rw("execute store result score @s t run kill @s")).toMatchObject({ status: "unsupported", issues: [{ message: expect.stringContaining("execute store") }] });
    expect(rw("data get storage a:b")).toMatchObject({ status: "unsupported", issues: [{ message: expect.stringContaining("data") }] });
    expect(rw("setblock 1 2 3 stone strict")).toMatchObject({ status: "unsupported" });
    expect(rw("scoreboard objectives add t minecraft.custom:minecraft.jump")).toMatchObject({ status: "unsupported" });
    expect(rw("kill @e[nbt={a:1b}]")).toMatchObject({ status: "unsupported" });
    expect(rw("give @a minecraft:diamond")).toMatchObject({ status: "unsupported" });
    expect(rw("kill @e[")).toMatchObject({ status: "invalid" });
  });
});
