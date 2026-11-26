// Java のチャンクからコマンドブロックを取り出し、チェーンを復元する（#12）。サーバーにも Node にも依存しない。
import type { CommandBlockKind } from "../bedrock/mcstructure.ts";
import type { NbtCompound } from "../nbt/nbt.ts";
import { blockAt, blockEntities, child, nbtToPlain, type BlockDefaults } from "./world.ts";

export type JavaFacing = "down" | "up" | "north" | "south" | "west" | "east";

export interface CommandBlockInfo {
  /** "minecraft:overworld" など */
  dimension: string;
  pos: [number, number, number];
  /** ブロックの種類がわからなければ undefined（パレットの読み取りに失敗したなど） */
  kind: CommandBlockKind | undefined;
  facing: JavaFacing | undefined;
  conditional: boolean;
  /** 常時実行（NBT の auto） */
  auto: boolean;
  command: string;
  /** CustomName（テキストコンポーネントを JSON 化したもの） */
  customName?: unknown;
  trackOutput: boolean;
}

const KINDS: Record<string, CommandBlockKind> = {
  "minecraft:command_block": "impulse",
  "minecraft:chain_command_block": "chain",
  "minecraft:repeating_command_block": "repeat",
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

/**
 * チャンクの NBT からコマンドブロックを取り出す。
 * defaults がないと、26.x で既定値の向き（north）のコマンドブロックの facing が undefined になる。
 */
export function commandBlocksInChunk(chunk: NbtCompound, dimension: string, defaults?: BlockDefaults): CommandBlockInfo[] {
  const out: CommandBlockInfo[] = [];
  for (const be of blockEntities(chunk)) {
    const id = child(be, "id");
    if (id?.type !== "string" || id.value !== "minecraft:command_block") continue;
    const plain = nbtToPlain(be) as Record<string, unknown>;
    const pos: [number, number, number] = [num(plain.x), num(plain.y), num(plain.z)];
    const state = blockAt(chunk, ...pos, defaults);
    const facing = state?.properties.facing as JavaFacing | undefined;
    out.push({
      dimension,
      pos,
      kind: state ? KINDS[state.name] : undefined,
      facing,
      conditional: state?.properties.conditional === "true",
      auto: num(plain.auto ?? 0) === 1,
      command: typeof plain.Command === "string" ? plain.Command : "",
      ...(plain.CustomName !== undefined ? { customName: plain.CustomName } : {}),
      trackOutput: num(plain.TrackOutput ?? 1) === 1,
    });
  }
  return out;
}

const DIRS: Record<JavaFacing, [number, number, number]> = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};

export interface Chains {
  /** 先頭がインパルスかリピート（または種類不明）で、向きの方向に続くチェーンコマンドブロックをたどったもの */
  chains: CommandBlockInfo[][];
  /** どのチェーンからもたどれないチェーンコマンドブロック */
  orphans: CommandBlockInfo[];
}

const key = (c: { dimension: string; pos: number[] }): string => `${c.dimension} ${c.pos.join(",")}`;

/** Java の条件付きブロックが成否を参照する座標。 */
export function commandBlockBehind(block: CommandBlockInfo): CommandBlockInfo["pos"] | undefined {
  const d = block.facing && DIRS[block.facing];
  if (d) return [block.pos[0] - d[0], block.pos[1] - d[1], block.pos[2] - d[2]];
}

/** 先端が指すチェーンブロックへの有向辺。 */
export function commandBlockLinks(cbs: readonly CommandBlockInfo[]): Map<CommandBlockInfo, CommandBlockInfo> {
  const byPos = new Map(cbs.map((c) => [key(c), c]));
  const links = new Map<CommandBlockInfo, CommandBlockInfo>();
  for (const block of cbs) {
    const d = block.facing && DIRS[block.facing];
    if (!d) continue;
    const [x, y, z] = block.pos;
    const next = byPos.get(key({dimension: block.dimension, pos: [x + d[0], y + d[1], z + d[2]]}));
    if (next?.kind === "chain") links.set(block, next);
  }
  return links;
}

/** チェーンを復元する（scripts/analyze_chains.py の build_chains と同じ手順） */
export function buildChains(cbs: readonly CommandBlockInfo[]): Chains {
  const links = commandBlockLinks(cbs);
  const used = new Set<string>();
  const chains: CommandBlockInfo[][] = [];
  for (const c of cbs) {
    if (c.kind === "chain") continue;
    const seq = [c];
    const seen = new Set([key(c)]);
    for (;;) {
      const last = seq[seq.length - 1]!;
      const next = links.get(last);
      if (!next || seen.has(key(next))) break;
      seen.add(key(next));
      seq.push(next);
    }
    for (const k of seen) used.add(k);
    chains.push(seq);
  }
  return { chains, orphans: cbs.filter((c) => !used.has(key(c))) };
}
