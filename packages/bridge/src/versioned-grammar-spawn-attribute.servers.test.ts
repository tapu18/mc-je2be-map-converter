import { join } from "node:path";
import { expect, it } from "vitest";
import {
  CommandParser, nbtToPlain, normalize1_21Attribute, normalize1_21_9SpawnRotation,
  toCommandIR, type CommandIR, type ParsedNode,
} from "@je2be/core";
import { javaGrammarSources, loadGrammarTree, readGzipNbt, setupJavaGrammar, type JavaGrammarInstallation } from "@je2be/converter";
import { JavaServer } from "./java.ts";

async function grammar(version: string): Promise<JavaGrammarInstallation> {
  const source = javaGrammarSources().find(entry => entry.version === version);
  if (!source) throw new Error(`Missing grammar ${version}`);
  return setupJavaGrammar(source);
}

function parse(parser: CommandParser, source: string): CommandIR {
  const result = parser.parse(source);
  if (!result.ok) throw new Error(`${source}: ${JSON.stringify(result.error)}`);
  return toCommandIR(source, result.nodes);
}

function withoutSourceLocations(ir: CommandIR): unknown {
  const withoutSpan = ({ start, end, ...node }: ParsedNode) => node;
  return {
    context: ir.context.map(step => ({ ...step, nodes: step.nodes.map(withoutSpan) })),
    command: ir.command && {
      ...ir.command,
      nodes: ir.command.nodes.map(withoutSpan),
      ...(ir.command.run ? { run: withoutSourceLocations(ir.command.run) } : {}),
    },
  };
}

async function compareIR(
  before: string, after: string, normalize: (ir: CommandIR) => CommandIR, cases: (readonly [string, string])[],
): Promise<void> {
  const [legacy, current] = await Promise.all([grammar(before), grammar(after)]);
  const oldParser = new CommandParser(loadGrammarTree(legacy), { textFormat: legacy.textFormat });
  const newParser = new CommandParser(loadGrammarTree(current), { textFormat: current.textFormat });
  for (const [old, modern] of cases) {
    const normalized = normalize(parse(oldParser, old));
    expect(normalized.source).toBe(old);
    expect(withoutSourceLocations(normalized), old).toEqual(withoutSourceLocations(parse(newParser, modern)));
  }
}

const UUID = "12345678-1234-ABCD-9ABC-123456789ABC";
const ID = `minecraft:${UUID.toLowerCase()}`;
const SPEED_UUID = "91AEAA56-376B-4498-935B-2F7F68070635";
const SPEED_ID = "minecraft:effect.speed";
const OPERATIONS = ["add_value", "add_multiplied_base", "add_multiplied_total"];

it("normalizes the attribute modifier add, remove and value get routes", async () => {
  const modifier = "attribute @s minecraft:generic.max_health modifier";
  await compareIR("1.20.6", "1.21", normalize1_21Attribute, [
    ...OPERATIONS.map(operation => [
      `${modifier} add ${UUID} "old display name" 5 ${operation}`,
      `${modifier} add ${ID} 5 ${operation}`,
    ] as const),
    [`${modifier} remove ${UUID}`, `${modifier} remove ${ID}`],
    [`${modifier} value get ${UUID}`, `${modifier} value get ${ID}`],
    [`return run execute as @e run ${modifier} value get ${UUID} 10`, `return run execute as @e run ${modifier} value get ${ID} 10`],
    [`${modifier} value get ${SPEED_UUID}`, `${modifier} value get ${SPEED_ID}`],
    [`${modifier} remove 1-2-3-4-5`, `${modifier} remove minecraft:00000001-0002-0003-0004-000000000005`],
    ["attribute @s minecraft:generic.max_health base get", "attribute @s minecraft:generic.max_health base get"],
  ]);
});

it("normalizes absolute and relative yaw for both spawn commands", async () => {
  await compareIR("1.21.8", "1.21.9", normalize1_21_9SpawnRotation, [
    ["setworldspawn 0 64 0 90", "setworldspawn 0 64 0 90 0"],
    ["execute rotated 15 30 run setworldspawn 0 64 0 ~15", "execute rotated 15 30 run setworldspawn 0 64 0 ~15 0"],
    ["spawnpoint @a 0 64 0 -45", "spawnpoint @a 0 64 0 -45 0"],
    ["return run spawnpoint @a 0 64 0 ~", "return run spawnpoint @a 0 64 0 ~ 0"],
    ["spawnpoint @a 0 64 0", "spawnpoint @a 0 64 0"],
    ["setworldspawn", "setworldspawn"],
  ]);
});

it("applies and removes attribute modifiers and reads the speed effect on both Java versions", async () => {
  for (const [version, id, speed] of [["1.20.6", UUID, SPEED_UUID], ["1.21", ID, SPEED_ID]] as const) {
    const server = await JavaServer.start({ runtime: await grammar(version) });
    try {
      await server.exec("summon minecraft:pig 0 0 0 {NoAI:1b,Tags:[probe]}");
      const target = "@e[type=minecraft:pig,tag=probe,limit=1]";
      const health = `attribute ${target} minecraft:generic.max_health`;
      await server.exec("scoreboard objectives add probe dummy");
      const score = async (command: string): Promise<number> => {
        await server.exec("scoreboard players set probe probe -1");
        await server.exec(`execute store result score probe probe run ${command}`);
        const result = await server.exec("scoreboard players get probe probe");
        return Number(/^probe has (-?\d+) /.exec(result)?.[1]);
      };
      expect(await score(`${health} get`)).toBe(10);
      for (const [operation, amount, total] of [
        ["add_value", 5, 15], ["add_multiplied_base", 2, 30], ["add_multiplied_total", 2, 30],
      ] as const) {
        const name = version === "1.20.6" ? ' "display name"' : "";
        await server.exec(`${health} modifier add ${id}${name} ${amount} ${operation}`);
        expect(await score(`${health} modifier value get ${id} 10`)).toBe(amount * 10);
        expect(await score(`${health} get`)).toBe(total);
        await server.exec(`${health} modifier remove ${id}`);
        expect(await score(`${health} get`)).toBe(10);
      }
      await server.exec(`effect give ${target} minecraft:speed 60 0`);
      expect(await score(`attribute ${target} minecraft:generic.movement_speed modifier value get ${speed} 100`)).toBe(20);
    } finally { await server.stop(); }
  }
});

it("preserves saved world spawn yaw across Java 1.21.8 and 1.21.9", async () => {
  for (const [version, rotation] of [["1.21.8", "~15"], ["1.21.9", "~15 0"]] as const) {
    const server = await JavaServer.start({ runtime: await grammar(version) });
    try {
      const prefix = "execute rotated 20 40 run";
      // @a が空でも、文法エラーと対象なしの実行結果を区別できる。
      const personal = await server.exec(`${prefix} spawnpoint @a 2 64 3 ${rotation}`);
      expect(personal).toContain("No player was found");
      const spawn = await server.exec(`${prefix} setworldspawn 2 64 3 ${rotation}`);
      expect(spawn).toContain("35");
      await server.exec("save-all flush");
      const { Data } = nbtToPlain(readGzipNbt(join(server.worldDirectory, "level.dat"))) as { Data: object };
      if (version === "1.21.8") expect(Data).toMatchObject({ SpawnX: 2, SpawnY: 64, SpawnZ: 3, SpawnAngle: 35 });
      else expect(Data).toMatchObject({ spawn: { pos: [2, 64, 3], yaw: 35, pitch: 0 } });
    } finally { await server.stop(); }
  }
});
