// Java版ワールドの保存データから状態を取り出す（RCON の文字列出力では取れないブロックステートやエンティティ一覧のため）。
// 形は BDS の検証パックの応答（blocks / scores / entities）にそろえる。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, inflateSync } from "node:zlib";
import {
  blockAt,
  blockEntities,
  child,
  chunkEntities,
  nbtToPlain,
  readCommandStorage,
  readNbt,
  readScoreboard,
  RegionFile,
  type NbtCompound,
  type ObjectiveScores,
} from "@je2be/core";

export type Vec3 = [number, number, number];

export interface JavaDumpRequest {
  /** 範囲内のブロック（両端を含む） */
  blocks?: { from: Vec3; to?: Vec3; dimension?: string };
  scores?: boolean;
  /** command storage（`名前空間:パス` → 値） */
  storage?: boolean;
  entities?: boolean | { dimension?: string };
}

export interface JavaBlock {
  pos: Vec3;
  type: string;
  states: Record<string, string>;
  /** ブロックエンティティがあれば、その NBT（JSON 化したもの） */
  nbt?: unknown;
}

export interface JavaEntity {
  id: string;
  type: string;
  pos: Vec3;
  rot: [number, number];
  tags: string[];
  nbt: unknown;
}

export interface JavaDump {
  blocks?: JavaBlock[];
  scores?: ObjectiveScores[];
  storage?: Record<string, unknown>;
  entities?: JavaEntity[];
}

const decompress = (kind: "gzip" | "zlib", data: Uint8Array): Uint8Array =>
  new Uint8Array(kind === "gzip" ? gunzipSync(data) : inflateSync(data));

const readGzipNbt = (file: string): NbtCompound => readNbt(new Uint8Array(gunzipSync(readFileSync(file))), "java").tag;

/** ディメンションのディレクトリ（26.x は dimensions/<ns>/<名前>、それより前は ./、DIM-1、DIM1） */
function dimensionDir(world: string, dimension = "minecraft:overworld"): string {
  const [ns, name] = dimension.includes(":") ? dimension.split(":", 2) as [string, string] : ["minecraft", dimension];
  const modern = join(world, "dimensions", ns, name);
  if (existsSync(modern)) return modern;
  const legacy: Record<string, string> = { "minecraft:overworld": world, "minecraft:the_nether": join(world, "DIM-1"), "minecraft:the_end": join(world, "DIM1") };
  return legacy[`${ns}:${name}`] ?? modern;
}

class RegionCache {
  private readonly cache = new Map<string, RegionFile | undefined>();
  private readonly chunks = new Map<string, NbtCompound | undefined>();
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  chunk(cx: number, cz: number): NbtCompound | undefined {
    const key = `${cx},${cz}`;
    if (this.chunks.has(key)) return this.chunks.get(key);
    const rx = Math.floor(cx / 32);
    const rz = Math.floor(cz / 32);
    const file = join(this.dir, `r.${rx}.${rz}.mca`);
    if (!this.cache.has(file)) this.cache.set(file, existsSync(file) ? new RegionFile(new Uint8Array(readFileSync(file)), decompress) : undefined);
    const c = this.cache.get(file)?.chunk(cx - rx * 32, cz - rz * 32);
    this.chunks.set(key, c);
    return c;
  }
}

const num = (t: unknown): number => (typeof t === "number" ? t : Number(t));

function uuidString(ints: unknown): string {
  if (!Array.isArray(ints) || ints.length !== 4) return "";
  const hex = ints.map((i) => (Number(i) >>> 0).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 保存済みのワールドディレクトリから状態を読む */
export function dumpJavaWorld(world: string, req: JavaDumpRequest): JavaDump {
  const out: JavaDump = {};

  if (req.blocks) {
    const { from, to = from, dimension } = req.blocks;
    const regions = new RegionCache(join(dimensionDir(world, dimension), "region"));
    const lo = from.map((v, i) => Math.min(v, to[i]!)) as Vec3;
    const hi = from.map((v, i) => Math.max(v, to[i]!)) as Vec3;
    const blocks: JavaBlock[] = [];
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          const chunk = regions.chunk(Math.floor(x / 16), Math.floor(z / 16));
          const state = chunk ? blockAt(chunk, x, y, z) : undefined;
          if (!state) continue;
          const be = chunk
            ? blockEntities(chunk).find((b) => num(nbtToPlain(child(b, "x")!)) === x && num(nbtToPlain(child(b, "y")!)) === y && num(nbtToPlain(child(b, "z")!)) === z)
            : undefined;
          blocks.push({ pos: [x, y, z], type: state.name, states: state.properties, ...(be ? { nbt: nbtToPlain(be) } : {}) });
        }
    out.blocks = blocks;
  }

  if (req.scores) {
    const file = join(world, "data", "minecraft", "scoreboard.dat");
    const legacy = join(world, "data", "scoreboard.dat");
    const path = existsSync(file) ? file : legacy;
    out.scores = existsSync(path) ? readScoreboard(readGzipNbt(path)) : [];
  }

  if (req.storage) {
    const storage: Record<string, unknown> = {};
    const dataDir = join(world, "data");
    if (existsSync(dataDir)) {
      for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
        // 26.x：data/<名前空間>/command_storage.dat、それより前：data/command_storage_<名前空間>.dat
        const modern = entry.isDirectory() ? join(dataDir, entry.name, "command_storage.dat") : undefined;
        const legacy = /^command_storage_(.+)\.dat$/.exec(entry.name);
        const [ns, file] = modern && existsSync(modern) ? [entry.name, modern] : legacy ? [legacy[1]!, join(dataDir, entry.name)] : [undefined, undefined];
        if (!ns || !file) continue;
        for (const [k, v] of readCommandStorage(ns, readGzipNbt(file))) storage[k] = nbtToPlain(v);
      }
    }
    out.storage = storage;
  }

  if (req.entities) {
    const dimension = typeof req.entities === "object" ? req.entities.dimension : undefined;
    const dir = join(dimensionDir(world, dimension), "entities");
    const entities: JavaEntity[] = [];
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((n) => /^r\.-?\d+\.-?\d+\.mca$/.test(n))) {
        const region = new RegionFile(new Uint8Array(readFileSync(join(dir, f))), decompress);
        for (let lz = 0; lz < 32; lz++)
          for (let lx = 0; lx < 32; lx++) {
            const chunk = region.chunk(lx, lz);
            if (!chunk) continue;
            for (const e of chunkEntities(chunk)) {
              const plain = nbtToPlain(e) as Record<string, unknown>;
              const pos = (plain.Pos as number[] | undefined) ?? [];
              const rot = (plain.Rotation as number[] | undefined) ?? [];
              entities.push({
                id: uuidString(plain.UUID),
                type: String(plain.id),
                pos: [num(pos[0]), num(pos[1]), num(pos[2])],
                rot: [num(rot[1] ?? 0), num(rot[0] ?? 0)],
                tags: (plain.Tags as string[] | undefined) ?? [],
                nbt: plain,
              });
            }
          }
      }
    }
    out.entities = entities;
  }

  return out;
}
