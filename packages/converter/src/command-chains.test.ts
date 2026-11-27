import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { blockEntities, deserializeCommandIR, MappingLookup, nbt, nbtToPlain, writeNbt, type CommandBlockInfo, type CommandTreeNode } from "@je2be/core";
import { expect, it } from "vitest";
import { prepareWorldCommands } from "./command-rewrite.ts";
import { fixedJavaDataVersion } from "./java-grammars.ts";
import { JavaWorld } from "./java-world.ts";

type FixtureBlock = {
  x: number; z: number; command: string; facing: CommandBlockInfo["facing"];
  chain?: boolean; conditional?: boolean;
};

function writeRegion(dir: string, chunkZ: number, blocks: FixtureBlock[]) {
  const palette = [nbt.compound({ Name: nbt.string("minecraft:air") })];
  const states = new BigInt64Array(256);
  for (const [index, block] of blocks.entries()) {
    palette.push(nbt.compound({
      Name: nbt.string(block.chain ? "minecraft:chain_command_block" : "minecraft:command_block"),
      Properties: nbt.compound({ facing: nbt.string(block.facing!), conditional: nbt.string(String(!!block.conditional)) }),
    }));
    const i = (block.z % 16) * 16 + block.x;
    states[i >> 4] = states[i >> 4]! | (BigInt(index + 1) << BigInt((i % 16) * 4));
  }
  const body = writeNbt({ name: "", tag: nbt.compound({
    sections: nbt.list("compound", [nbt.compound({ Y: nbt.byte(0), block_states: nbt.compound({
      palette: nbt.list("compound", palette), data: { type: "longArray", value: states },
    }) })]),
    block_entities: nbt.list("compound", blocks.map(block => nbt.compound({
      id: nbt.string("minecraft:command_block"), x: nbt.int(block.x), y: nbt.int(0), z: nbt.int(block.z),
      Command: nbt.string(block.command), auto: nbt.byte(1), powered: nbt.byte(1), SuccessCount: nbt.int(2),
    }))),
  }) }, "java");
  const region = Buffer.alloc(3 * 4096);
  region.writeUInt32BE((2 << 8) | 1, (chunkZ % 32) * 32 * 4);
  region.writeUInt32BE(body.length + 1, 8192);
  region[8196] = 3;
  region.set(body, 8197);
  writeFileSync(join(dir, `r.0.${Math.floor(chunkZ / 32)}.mca`), region);
}

it("reports native, runtime and unsupported chains at their Java coordinates", () => {
  const dir = mkdtempSync(join(tmpdir(), "je2be-chains-"));
  try {
    const region = join(dir, "region");
    mkdirSync(region);
    writeFileSync(join(dir, "level.dat"), gzipSync(writeNbt({ name: "", tag: nbt.compound({
      Data: nbt.compound({ DataVersion: nbt.int(fixedJavaDataVersion) }),
    }) }, "java")));
    const tree: CommandTreeNode = { type: "root", children: {
      say: { type: "literal", children: { message: { type: "argument", parser: "minecraft:message", executable: true } } },
      return: { type: "literal", children: { value: { type: "argument", parser: "brigadier:integer", executable: true } } },
    } };
    const commandsJson = join(dir, "commands.json");
    const blocksJson = join(dir, "blocks.json");
    writeFileSync(commandsJson, JSON.stringify(tree));
    writeFileSync(blocksJson, "{}");
    writeRegion(region, 31, [
      { x: 0, z: 511, command: "return 1", facing: "south" },
      { x: 2, z: 511, command: "say guarded", facing: "south" },
      { x: 4, z: 511, command: "say native", facing: "south" },
      { x: 6, z: 511, command: "return 1", facing: "south" },
    ]);
    writeRegion(region, 32, [
      { x: 0, z: 512, command: "say delegated", facing: "south", chain: true, conditional: true },
      { x: 2, z: 512, command: "return 1", facing: "south", chain: true, conditional: true },
      { x: 6, z: 512, command: "say joined", facing: "south", chain: true },
      { x: 7, z: 512, command: "say second head", facing: "west" },
      { x: 10, z: 512, command: "say loop", facing: "east", chain: true },
      { x: 11, z: 512, command: "say loop", facing: "west", chain: true },
    ]);
    const mappings = new MappingLookup({
      schemaVersion: 1, source: { repository: "", revision: "", javaVersion: "", bedrockVersion: "", sha256: {} }, blocks: [], items: [],
    });
    const {report, runtimeChains} = prepareWorldCommands(dir, { commandsJson, blocksJson, mappingsJson: "" }, mappings, {
      datapacks: { schemaVersion: 1, packs: [] }, nativeCommands: [],
    });
    const site = (x: number, z: number) => ({ dimension: "minecraft:overworld", pos: [x, 0, z] });
    expect(report.chains).toEqual([
      { head: site(0, 511), blocks: [[0, 0, 511], [0, 0, 512]], status: "runtime",
        reason: expect.stringContaining("BE コマンド 1 個"), at: site(0, 511), launcherId: "chain@0" },
      { head: site(2, 511), blocks: [[2, 0, 511], [2, 0, 512]], status: "unsupported",
        reason: expect.stringContaining("#93 の判断待ち"), at: site(2, 511) },
      { head: site(4, 511), blocks: [[4, 0, 511]], status: "native", reason: expect.stringContaining("BE コマンド") },
      { head: site(6, 511), blocks: [[6, 0, 511], [6, 0, 512], [7, 0, 512]], status: "unsupported", reason: expect.stringContaining("合流") },
      { head: site(10, 512), blocks: [[10, 0, 512], [11, 0, 512]], status: "unsupported", reason: expect.stringContaining("ループ") },
    ]);
    const chain = runtimeChains["chain@0"]!;
    expect(Object.keys(runtimeChains)).toEqual(["chain@0"]);
    expect(chain.nativeCommands).toEqual([["say delegated", "say delegated"]]);
    expect(deserializeCommandIR(chain.blocks[0]!.command!)).toMatchObject({ok: true, document: {ir: {source: "return 1"}}});
    const world = new JavaWorld(dir);
    const read = (chunkZ: number) => blockEntities(world.chunk("minecraft:overworld", 0, chunkZ)!).map(nbtToPlain);
    expect(read(31)).toEqual(expect.arrayContaining([
      expect.objectContaining({x: 0, Command: 'je2be:run "chain@0" ~ ~ ~ ^ ^ ^1 minecraft:overworld', auto: 1}),
      expect.objectContaining({x: 2, Command: "say guarded", auto: 1}),
    ]));
    expect(read(32)).toEqual(expect.arrayContaining([
      expect.objectContaining({x: 0, Command: "", auto: 0, powered: 0, SuccessCount: 0}),
      expect.objectContaining({x: 2, Command: "return 1", auto: 1}),
    ]));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
