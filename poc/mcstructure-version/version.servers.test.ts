// #9: BDS自身が保存するversion値と、生成した構造物の新execute構文を実測する。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  buildMcstructure, commandBlock, DEFAULT_BLOCK_VERSION, DEFAULT_COMMAND_BLOCK_VERSION,
  readNbt, type NbtTag,
} from "@je2be/core";
import { BedrockServer } from "@je2be/bridge";
import { paths } from "../../packages/bridge/src/paths.ts";
import { readSavedStructure } from "./leveldb-log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pack = join(here, "pack");

function get(tag: NbtTag, ...path: string[]): NbtTag {
  for (const key of path) {
    if (tag.type !== "compound") throw new Error(`not a compound: ${key}`);
    const next = tag.value.get(key);
    if (!next) throw new Error(`missing NBT: ${key}`);
    tag = next;
  }
  return tag;
}

function versions(bytes: Uint8Array): { blockVersions: number[]; commandVersions: number[] } {
  const { tag, length } = readNbt(bytes, "bedrock");
  expect(length).toBe(bytes.length);
  const palette = get(tag, "structure", "palette", "default");
  const blocks = get(palette, "block_palette");
  const positions = get(palette, "block_position_data");
  if (blocks.type !== "list" || positions.type !== "compound") throw new Error("invalid structure palette");
  const int = (t: NbtTag): number => {
    if (t.type !== "int") throw new Error("expected int");
    return t.value;
  };
  const commandVersions = [...positions.value.values()].map((p) => int(get(p, "block_entity_data", "Version")));
  const blockVersions = blocks.value.map((b) => int(get(b, "version")));
  expect(commandVersions).toHaveLength(3);
  expect(blockVersions.length).toBeGreaterThanOrEqual(3);
  return { blockVersions, commandVersions };
}

it("matches native BDS versions and executes modern commands from generated command blocks", async () => {
  mkdirSync(join(pack, "structures", "je2be"), { recursive: true });
  writeFileSync(join(pack, "structures", "je2be", "versions.mcstructure"), buildMcstructure({
    size: [3, 1, 2],
    blocks: [
      commandBlock({ pos: [0, 0, 0], kind: "impulse", facing: 3, alwaysActive: true,
        command: "execute positioned 8.5 -50 8.5 if block ~ ~ ~ stone run scoreboard players set impulse versions 11" }),
      commandBlock({ pos: [0, 0, 1], kind: "chain", facing: 3, alwaysActive: true, conditional: true,
        command: "execute if score impulse versions matches 11 run scoreboard players set chain versions 22" }),
      commandBlock({ pos: [2, 0, 0], kind: "repeat", facing: 3, alwaysActive: true,
        command: "execute unless score repeat versions matches 33 run scoreboard players set repeat versions 33" }),
    ],
  }));

  const bds = await BedrockServer.start({ behaviorPacks: [pack] });
  let scores: Record<string, number> = {};
  try {
    for (const [i, kind] of ["command_block", "chain_command_block", "repeating_command_block"].entries()) {
      expect((await bds.exec(`setblock 20 -50 ${i} ${kind}`)).result?.successCount).toBe(1);
    }
    // setblockで作ったブロックの初期値を保存する。生成NBTの値を読み戻すだけにはしない。
    expect((await bds.exec("structure save je2be:native_versions 20 -50 0 20 -50 2 false disk true")).result?.successCount).toBe(1);

    expect((await bds.exec("scoreboard objectives add versions dummy")).result?.successCount).toBe(1);
    expect((await bds.exec("setblock 8 -50 8 stone")).result?.successCount).toBe(1);
    expect((await bds.exec("structure load je2be:versions 0 -50 0")).result?.successCount).toBe(1);
    const deadline = Date.now() + 5000;
    do {
      const res = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
      expect(res.ok).toBe(true);
      scores = Object.fromEntries((res.result?.find((o) => o.objective === "versions")?.scores ?? []).map((s) => [s.participant, s.score]));
      if (scores.impulse === 11 && scores.chain === 22 && scores.repeat === 33) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    expect(scores).toEqual({ impulse: 11, chain: 22, repeat: 33 });
    expect((await bds.exec("structure save je2be:loaded_versions 0 -50 0 2 -50 1 false disk true")).result?.successCount).toBe(1);
  } finally {
    await bds.stop();
  }

  const db = join(paths.bedrockServer, "worlds", "je2be-test", "db");
  const nativeBytes = readSavedStructure(db, "je2be:native_versions");
  const native = versions(nativeBytes);
  const loaded = versions(readSavedStructure(db, "je2be:loaded_versions"));
  for (const result of [native, loaded]) {
    expect(new Set(result.blockVersions)).toEqual(new Set([DEFAULT_BLOCK_VERSION]));
    expect(result.commandVersions).toEqual(new Array(3).fill(DEFAULT_COMMAND_BLOCK_VERSION));
  }

  writeFileSync(join(here, "native.mcstructure"), nativeBytes);
  const config = JSON.parse(readFileSync(join(here, "../../tools/servers.json"), "utf8")) as { bedrock: { version: string } };
  writeFileSync(join(here, "results.json"), JSON.stringify({ bedrock: config.bedrock.version, native, loaded, scores }, null, 2) + "\n");
});
