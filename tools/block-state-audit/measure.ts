// Run from the repository root. See docs/findings.md for the measurement procedure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync, gunzipSync, inflateSync } from "node:zlib";
import { readNbt, writeNbt, type NbtCompound, type NbtTag } from "../../packages/core/src/nbt/nbt.ts";
import { blockAt, child, RegionFile } from "../../packages/core/src/java/world.ts";
import { DEFAULT_CHUNKER_FORMAT } from "../../packages/converter/src/convert.ts";

type JavaState = Record<string, string>;
type BedrockState = Record<string, string | number | boolean>;
type Block<T> = { id: string; states: T };
type Mapping = { java: Block<JavaState>; bedrock: Block<BedrockState> };

function key(block: Block<JavaState | BedrockState>, formatValue: (value: string | number | boolean) => string = String): string {
  const states = Object.entries(block.states).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return states.length ? block.id + "[" + states.map(([k, v]) => `${k}=${formatValue(v)}`).join(",") + "]" : block.id;
}

const bedrockKey = (block: Block<BedrockState>): string => key(block, value => JSON.stringify(value));
const compound = (value: Record<string, NbtTag>): NbtCompound => ({ type: "compound", value: new Map(Object.entries(value)) });
const int = (value: number): NbtTag => ({ type: "int", value });
const str = (value: string): NbtTag => ({ type: "string", value });
const list = (value: NbtCompound[]): NbtTag => ({ type: "list", elementType: "compound", value });

const config = JSON.parse(readFileSync("tools/servers.json", "utf8"));
const report: Record<string, { states: { properties?: JavaState }[] }> =
  JSON.parse(readFileSync(`servers/reports-${config.java.version}/reports/blocks.json`, "utf8"));
const mappings: { source: unknown; blocks: Mapping[] } = JSON.parse(readFileSync("servers/mappings/mappings.json", "utf8"));
const states = Object.entries(report).flatMap(([id, { states }]) => states.map(s => ({ id, states: s.properties ?? {} })));
const javaKeys = states.map(state => key(state));
const geyser = new Map(mappings.blocks.map(row => [key(row.java), row.bedrock]));
assert.equal(new Set(javaKeys).size, states.length);
assert.equal(geyser.size, mappings.blocks.length);
assert.equal(states.length, geyser.size);
for (const state of javaKeys) assert(geyser.has(state), state);

const air = { id: "minecraft:air", states: {} };
const marker = { id: "minecraft:diamond_block", states: {} };
const sectionY = 4;
const samplesPerChunk = 8 ** 3;

function position(index: number): [number, number, number] {
  // Separate test cells by one block of air in all three directions.
  return [1 + (index % 8) * 2, 1 + (Math.floor(index / 64) % 8) * 2, 1 + (Math.floor(index / 8) % 8) * 2];
}

function chunk(cx: number, cz: number, samples: Block<JavaState>[]): Buffer {
  const blocks: Block<JavaState>[] = [air, marker, ...samples];
  const palette = blocks.map(block => compound({
    id: str(block.id),
    properties: compound(Object.fromEntries(Object.entries(block.states).map(([k, v]) => [k, str(v)]))),
  }));
  const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
  const perWord = Math.floor(64 / bits);
  const data = new BigInt64Array(Math.ceil(4096 / perWord));
  const place = (x: number, y: number, z: number, index: number): void => {
    const cell = (y * 16 + z) * 16 + x;
    const word = Math.floor(cell / perWord);
    data[word] = data[word]! | (BigInt(index) << BigInt((cell % perWord) * bits));
  };
  place(2, 4, 6, 1);
  samples.forEach((_, i) => {
    place(...position(i), i + 2);
  });
  return deflateSync(writeNbt({ name: "", tag: compound({
    DataVersion: int(config.java.dataVersion),
    xPos: int(cx),
    yPos: int(-4),
    zPos: int(cz),
    Status: str("minecraft:full"),
    sections: list([compound({
      Y: { type: "byte", value: sectionY },
      block_states: compound({ palette: list(palette), data: { type: "longArray", value: data } }),
      biomes: compound({ palette: { type: "list", elementType: "string", value: [str("minecraft:plains")] } }),
    })]),
  }) }, "java"));
}

function writeJavaWorld(dir: string, level: string): number {
  mkdirSync(join(dir, "dimensions/minecraft/overworld/region"), { recursive: true });
  copyFileSync(level, join(dir, "level.dat"));
  const count = Math.ceil(states.length / samplesPerChunk);
  assert(count <= 1024, "fixture exceeds a single region");
  const header = Buffer.alloc(8192);
  const chunks: Buffer[] = [];
  let sector = 2;
  for (let i = 0; i < count; i++) {
    const payload = chunk(i % 32, Math.floor(i / 32), states.slice(i * samplesPerChunk, (i + 1) * samplesPerChunk));
    const record = Buffer.alloc(Math.ceil((payload.length + 5) / 4096) * 4096);
    record.writeUInt32BE(payload.length + 1);
    record[4] = 2;
    payload.copy(record, 5);
    header.writeUInt32BE(sector * 256 + record.length / 4096, i * 4);
    sector += record.length / 4096;
    chunks.push(record);
  }
  const file = join(dir, "dimensions/minecraft/overworld/region/r.0.0.mca");
  writeFileSync(file, Buffer.concat([header, ...chunks]));
  const region = new RegionFile(readFileSync(file), (_, bytes) => inflateSync(bytes));
  for (let i = 0; i < count; i++) {
    const saved = region.chunk(i % 32, Math.floor(i / 32))!;
    const begin = i * samplesPerChunk;
    for (let j = 0; j < Math.min(samplesPerChunk, states.length - begin); j++) {
      const [x, y, z] = position(j);
      const block = blockAt(saved, x, sectionY * 16 + y, z)!;
      assert.equal(key({ id: block.name, states: block.properties }), javaKeys[begin + j]);
    }
  }
  return count;
}

type BedrockLayer = { words: Buffer; bits: number; palette: Block<BedrockState>[] };

function readLayers(data: Buffer): BedrockLayer[] {
  assert.equal(data[0], 9, "unexpected subchunk version");
  assert.equal(data.readInt8(2), sectionY);
  let offset = 3;
  const layers: BedrockLayer[] = [];
  for (let layer = 0; layer < data[1]!; layer++) {
    const header = data.readUInt8(offset++);
    assert.equal(header & 1, 0, "expected persistent palette");
    const bits = header >> 1;
    assert([0, 1, 2, 3, 4, 5, 6, 8, 16].includes(bits));
    const byteCount = bits === 0 ? 0 : 4 * Math.ceil(4096 / Math.floor(32 / bits));
    const words = data.subarray(offset, offset + byteCount);
    offset += byteCount;
    const count = bits === 0 ? 1 : data.readUInt32LE(offset);
    if (bits !== 0) offset += 4;
    assert(count > 0 && count <= 4096);
    const palette = Array.from({ length: count }, () => {
      const nbt = readNbt(data.subarray(offset), "bedrock");
      offset += nbt.length;
      const name = child(nbt.tag, "name");
      const states = child(nbt.tag, "states");
      assert(name?.type === "string" && states?.type === "compound");
      return { id: name.value, states: Object.fromEntries([...states.value].map(([k, v]) => {
        assert(v.type === "byte" || v.type === "int" || v.type === "string");
        if (v.type === "byte") assert(v.value === 0 || v.value === 1);
        return [k, v.type === "byte" ? Boolean(v.value) : v.value];
      })) };
    });
    layers.push({ words, bits, palette });
  }
  assert.equal(offset, data.length);
  return layers;
}

function bedrockAt(layer: BedrockLayer, [x, y, z]: [number, number, number]): Block<BedrockState> {
  if (layer.bits === 0) return layer.palette[0]!;
  const cell = (x * 16 + z) * 16 + y;
  const perWord = Math.floor(32 / layer.bits);
  const word = layer.words.readUInt32LE(4 * Math.floor(cell / perWord));
  const index = (word >>> ((cell % perWord) * layer.bits)) & ((1 << layer.bits) - 1);
  const state = layer.palette[index];
  assert(state, `palette index ${index} out of range`);
  return state;
}

const [scratchArg, level, jdk = "java"] = process.argv.slice(2);
assert(scratchArg && level, "usage: node tools/block-state-audit/measure.ts <new scratch dir> <JE level.dat> [JDK java]");
const levelData = child(readNbt(gunzipSync(readFileSync(level)), "java").tag, "Data");
assert.deepEqual(child(levelData, "DataVersion"), int(config.java.dataVersion));
const scratch = resolve(scratchArg);
mkdirSync(scratch);
const input = join(scratch, "java");
const output = join(scratch, "bedrock");
const subchunks = join(scratch, "subchunks");
const java = "servers/jre/bin/java";
const jar = `servers/tools/chunker-cli-${config.chunker.version}.jar`;
const count = writeJavaWorld(input, level);
execFileSync(java, ["-Xmx1G", "-jar", jar, "-i", input, "-f", DEFAULT_CHUNKER_FORMAT, "-o", output], { stdio: "inherit" });
execFileSync(jdk, ["-cp", jar, "tools/block-state-audit/DumpSubchunks.java", join(output, "db"), subchunks], { stdio: "inherit" });

let equal = 0;
let extraLayer = 0;
const differences = [];
for (let i = 0; i < count; i++) {
  const layers = readLayers(readFileSync(join(subchunks, `${i % 32}.${Math.floor(i / 32)}.${sectionY}`)));
  assert(layers[0], "missing primary layer");
  assert.equal(bedrockAt(layers[0], [2, 4, 6]).id, marker.id, `marker in chunk ${i}`);
  assert.equal(bedrockAt(layers[0], [6, 4, 2]).id, air.id, `empty control in chunk ${i}`);
  const begin = i * samplesPerChunk;
  for (let j = 0; j < Math.min(samplesPerChunk, states.length - begin); j++) {
    const java = javaKeys[begin + j]!;
    const expected = geyser.get(java)!;
    const chunker = layers.map(layer => bedrockAt(layer, position(j)));
    const primary = chunker[0]!;
    const extra = chunker.slice(1).filter(block => block.id !== air.id).map(bedrockKey);
    if (extra.length) extraLayer++;
    if (bedrockKey(primary) === bedrockKey(expected) && !extra.length) equal++;
    else differences.push({ java, geyser: bedrockKey(expected), chunker: bedrockKey(primary), extra });
  }
}
writeFileSync(join(scratch, "comparison.json"), JSON.stringify({
  java: config.java.version, chunker: config.chunker.version, format: DEFAULT_CHUNKER_FORMAT,
  mapping: mappings.source, chunks: count, states: states.length, equal, extraLayer, differences,
}, null, 2) + "\n");
console.log(`${states.length} states, ${equal} equal, ${differences.length} different, ${extraLayer} with non-air extra layers`);
