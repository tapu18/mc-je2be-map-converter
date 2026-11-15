import { describe, expect, it } from "vitest";
import { nbt, type NbtTag } from "../nbt/nbt.ts";
import { buildChains, commandBlocksInChunk, type CommandBlockInfo } from "./command-blocks.ts";

const cb = (x: number, kind: CommandBlockInfo["kind"], facing: CommandBlockInfo["facing"], z = 0, extra: Partial<CommandBlockInfo> = {}): CommandBlockInfo => ({
  dimension: "minecraft:overworld", pos: [x, 0, z], kind, facing, conditional: false, auto: false, command: "", trackOutput: true, ...extra,
});

describe("command blocks", () => {
  it("builds chains following facing and leaves orphans", () => {
    const cbs = [
      cb(0, "impulse", "south"), cb(0, "chain", "south", 1), cb(0, "chain", "east", 2), cb(1, "chain", "east", 2),
      cb(5, "repeat", "up"),
      cb(9, "chain", "south"),
      // 先頭の向きの先が別の種類なら止まる
      cb(20, "impulse", "south"), cb(20, "impulse", "south", 1),
    ];
    const { chains, orphans } = buildChains(cbs);
    expect(chains.map((c) => c.map((b) => `${b.pos[0]},${b.pos[2]}`))).toEqual([["0,0", "0,1", "0,2", "1,2"], ["5,0"], ["20,0"], ["20,1"]]);
    expect(orphans.map((o) => o.pos[0])).toEqual([9]);
  });

  it("does not loop on cyclic chains", () => {
    const cbs = [cb(0, "repeat", "south"), cb(0, "chain", "east", 1), cb(1, "chain", "north", 1), cb(1, "chain", "west", 0)];
    const { chains } = buildChains(cbs);
    expect(chains[0]).toHaveLength(4);
  });

  it("reads command blocks from a chunk with block states", () => {
    const palette: NbtTag[] = [
      nbt.compound({ "": nbt.string("minecraft:air") }),
      nbt.compound({ id: nbt.string("minecraft:chain_command_block"), properties: nbt.compound({ conditional: nbt.string("true"), facing: nbt.string("up") }) }),
    ];
    // 位置 (1, 0, 2) だけ palette[1]
    const index = (0 * 16 + 2) * 16 + 1;
    const data = new BigInt64Array(256);
    data[Math.floor(index / 16)] = BigInt(1) << BigInt((index % 16) * 4);
    const chunk = nbt.compound({
      sections: nbt.list("compound", [nbt.compound({ Y: nbt.byte(0), block_states: nbt.compound({ palette: nbt.list("compound", palette), data: { type: "longArray", value: data } }) })]),
      block_entities: nbt.list("compound", [
        nbt.compound({ id: nbt.string("minecraft:command_block"), x: nbt.int(1), y: nbt.int(0), z: nbt.int(2), Command: nbt.string("say hi"), auto: nbt.byte(1), TrackOutput: nbt.byte(0) }),
        nbt.compound({ id: nbt.string("minecraft:chest"), x: nbt.int(3), y: nbt.int(0), z: nbt.int(3) }),
      ]),
    });
    expect(commandBlocksInChunk(chunk, "minecraft:overworld")).toEqual([
      { dimension: "minecraft:overworld", pos: [1, 0, 2], kind: "chain", facing: "up", conditional: true, auto: true, command: "say hi", trackOutput: false },
    ]);
  });
});
