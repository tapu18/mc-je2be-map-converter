// Java版ワールドのディレクトリを読む（Node 専用）。region・スコア・storage・エンティティの場所の違い（26.x と以前）を吸収する。
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, gunzipSync, inflateSync } from "node:zlib";
import {
  child,
  chunkEntities,
  rewriteRegion,
  readCommandStorage,
  readNbt,
  readScoreboard,
  RegionFile,
  type NbtCompound,
  type NbtTag,
  type ObjectiveScores,
} from "@je2be/core";

export const decompress = (kind: "gzip" | "zlib", data: Uint8Array): Uint8Array =>
  new Uint8Array(kind === "gzip" ? gunzipSync(data) : inflateSync(data));

export const readGzipNbt = (file: string): NbtCompound => readNbt(new Uint8Array(gunzipSync(readFileSync(file))), "java").tag;

const REGION_NAME = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

export class JavaWorld {
  readonly dir: string;
  private readonly regionCache = new Map<string, RegionFile | undefined>();

  constructor(dir: string) {
    if (!existsSync(join(dir, "level.dat"))) throw new Error(`${dir} にlevel.datがない（Java版ワールドではない）`);
    this.dir = dir;
  }

  /** level.dat の DataVersion */
  dataVersion(): number | undefined {
    const v = child(child(readGzipNbt(join(this.dir, "level.dat")), "Data"), "DataVersion");
    return v?.type === "int" ? v.value : undefined;
  }

  /** ワールドにあるディメンション（"minecraft:overworld" など） */
  dimensions(): string[] {
    const out = new Set<string>();
    const dims = join(this.dir, "dimensions");
    if (existsSync(dims)) {
      for (const ns of readdirSync(dims, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        for (const name of readdirSync(join(dims, ns.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
          if (["region", "entities"].some((folder) => existsSync(join(dims, ns.name, name.name, folder)))) out.add(`${ns.name}:${name.name}`);
        }
      }
    }
    // 26.x より前の場所
    if (existsSync(join(this.dir, "region"))) out.add("minecraft:overworld");
    if (existsSync(join(this.dir, "DIM-1", "region"))) out.add("minecraft:the_nether");
    if (existsSync(join(this.dir, "DIM1", "region"))) out.add("minecraft:the_end");
    return [...out].sort();
  }

  /** ディメンションのディレクトリ（26.x は dimensions/<ns>/<名前>、それより前は ./、DIM-1、DIM1） */
  dimensionDir(dimension = "minecraft:overworld"): string {
    const [ns, name] = dimension.includes(":") ? (dimension.split(":", 2) as [string, string]) : ["minecraft", dimension];
    const modern = join(this.dir, "dimensions", ns, name);
    if (existsSync(modern)) return modern;
    const legacy: Record<string, string> = { "minecraft:overworld": this.dir, "minecraft:the_nether": join(this.dir, "DIM-1"), "minecraft:the_end": join(this.dir, "DIM1") };
    return legacy[`${ns}:${name}`] ?? modern;
  }

  private region(file: string): RegionFile | undefined {
    if (!this.regionCache.has(file)) this.regionCache.set(file, existsSync(file) ? new RegionFile(new Uint8Array(readFileSync(file)), decompress) : undefined);
    return this.regionCache.get(file);
  }

  /** チャンク座標のチャンク（なければ undefined） */
  chunk(dimension: string, cx: number, cz: number, folder: "region" | "entities" = "region"): NbtCompound | undefined {
    const rx = Math.floor(cx / 32);
    const rz = Math.floor(cz / 32);
    return this.region(join(this.dimensionDir(dimension), folder, `r.${rx}.${rz}.mca`))?.chunk(cx - rx * 32, cz - rz * 32);
  }

  /** ディメンションの全チャンクを順に返す（region ファイルを1つずつ読み、読み終えたら手放す） */
  *chunks(dimension: string, folder: "region" | "entities" = "region"): Generator<NbtCompound> {
    const dir = join(this.dimensionDir(dimension), folder);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter((n) => REGION_NAME.test(n)).sort()) {
      const region = new RegionFile(new Uint8Array(readFileSync(join(dir, name))), decompress);
      for (let lz = 0; lz < 32; lz++)
        for (let lx = 0; lx < 32; lx++) {
          const c = region.chunk(lx, lz);
          if (c) yield c;
        }
    }
  }

  scoreboard(): ObjectiveScores[] {
    const modern = join(this.dir, "data", "minecraft", "scoreboard.dat");
    const legacy = join(this.dir, "data", "scoreboard.dat");
    const path = existsSync(modern) ? modern : legacy;
    return existsSync(path) ? readScoreboard(readGzipNbt(path)) : [];
  }

  /** command storage（`名前空間:パス` → 値）。26.x は data/<ns>/command_storage.dat、それより前は data/command_storage_<ns>.dat */
  storage(): Map<string, NbtTag> {
    const out = new Map<string, NbtTag>();
    const dataDir = join(this.dir, "data");
    if (!existsSync(dataDir)) return out;
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      const modern = entry.isDirectory() ? join(dataDir, entry.name, "command_storage.dat") : undefined;
      const legacy = /^command_storage_(.+)\.dat$/.exec(entry.name);
      const [ns, file] = modern && existsSync(modern) ? [entry.name, modern] : legacy ? [legacy[1]!, join(dataDir, entry.name)] : [undefined, undefined];
      if (!ns || !file) continue;
      for (const [k, v] of readCommandStorage(ns, readGzipNbt(file))) out.set(k, v);
    }
    return out;
  }

  /** ディメンションの全エンティティ（1.17 以降の entities/。それより前のチャンク内の Entities も読む） */
  *entities(dimension = "minecraft:overworld", legacy = true): Generator<NbtCompound> {
    let hasEntityChunks = false;
    for (const c of this.chunks(dimension, "entities")) {
      hasEntityChunks = true;
      yield* chunkEntities(c);
    }
    if (legacy && !hasEntityChunks) for (const c of this.chunks(dimension, "region")) yield* chunkEntities(c);
  }

  /** Chunker 用に作ったコピーからエンティティを除く。旧版で Chunker 自身も運ぶ場合の二重配置を防ぐ。 */
  removeEntitiesFromChunkerCopy(legacy: boolean): void {
    for (const dimension of this.dimensions()) {
      const dir = this.dimensionDir(dimension);
      rmSync(join(dir, "entities"), { recursive: true, force: true });
      if (!legacy) continue;
      const regionDir = join(dir, "region");
      if (!existsSync(regionDir)) continue;
      for (const name of readdirSync(regionDir).filter((n) => REGION_NAME.test(n))) {
        const file = join(regionDir, name);
        const result = rewriteRegion(readFileSync(file), decompress, deflateSync, (chunk) => {
          const level = child(chunk, "Level");
          const removedRoot = chunk.value.delete("Entities");
          const removedLevel = level?.type === "compound" && level.value.delete("Entities");
          return removedRoot || removedLevel ? chunk : undefined;
        });
        if (result) writeFileSync(file, result);
      }
    }
  }
}
