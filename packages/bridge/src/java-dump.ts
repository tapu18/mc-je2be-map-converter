// Java版ワールドの保存データから状態を取り出す（RCON の文字列出力では取れないブロックステートやエンティティ一覧のため）。
// 形は BDS の検証パックの応答（blocks / scores / entities）にそろえる。
import { blockAt, blockEntities, child, nbtToPlain, type ObjectiveScores } from "@je2be/core";
import { JavaWorld, loadBlockDefaults } from "@je2be/converter";
import { paths } from "./paths.ts";
import { existsSync } from "node:fs";
import type { BlockDefaults } from "@je2be/core";

let defaultsCache: BlockDefaults | undefined;
/** ブロックの既定の状態（blocks.json がなければ補わない） */
export function blockDefaults(): BlockDefaults | undefined {
  if (!defaultsCache && existsSync(paths.blocksReport)) defaultsCache = loadBlockDefaults(paths.blocksReport);
  return defaultsCache;
}

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

const num = (t: unknown): number => (typeof t === "number" ? t : Number(t));

function uuidString(ints: unknown): string {
  if (!Array.isArray(ints) || ints.length !== 4) return "";
  const hex = ints.map((i) => (Number(i) >>> 0).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 保存済みのワールドディレクトリから状態を読む（読み込みは @je2be/converter の JavaWorld） */
export function dumpJavaWorld(dir: string, req: JavaDumpRequest): JavaDump {
  const world = new JavaWorld(dir);
  const out: JavaDump = {};

  if (req.blocks) {
    const { from, to = from, dimension = "minecraft:overworld" } = req.blocks;
    const lo = from.map((v, i) => Math.min(v, to[i]!)) as Vec3;
    const hi = from.map((v, i) => Math.max(v, to[i]!)) as Vec3;
    const blocks: JavaBlock[] = [];
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          const chunk = world.chunk(dimension, Math.floor(x / 16), Math.floor(z / 16));
          const state = chunk ? blockAt(chunk, x, y, z, blockDefaults()) : undefined;
          if (!state) continue;
          const be = chunk
            ? blockEntities(chunk).find((b) => num(nbtToPlain(child(b, "x")!)) === x && num(nbtToPlain(child(b, "y")!)) === y && num(nbtToPlain(child(b, "z")!)) === z)
            : undefined;
          blocks.push({ pos: [x, y, z], type: state.name, states: state.properties, ...(be ? { nbt: nbtToPlain(be) } : {}) });
        }
    out.blocks = blocks;
  }

  if (req.scores) out.scores = world.scoreboard();

  if (req.storage) out.storage = Object.fromEntries([...world.storage()].map(([k, v]) => [k, nbtToPlain(v)]));

  if (req.entities) {
    const dimension = typeof req.entities === "object" ? req.entities.dimension : undefined;
    const entities: JavaEntity[] = [];
    for (const e of world.entities(dimension)) {
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
    out.entities = entities;
  }

  return out;
}
