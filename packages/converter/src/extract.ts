// Java版ワールドから、変換に必要なものを取り出す（#12、design.md 5.1）。
// コマンドブロック（種類・向き・条件付き・常時実行・コマンド）とチェーン、スコア、storage、エンティティ。
import { buildChains, commandBlocksInChunk, nbtToPlain, type BlockDefaults, type CommandBlockInfo, type ObjectiveScores } from "@je2be/core";
import { JavaWorld } from "./java-world.ts";

export interface ExtractedEntity {
  dimension: string;
  /** エンティティの NBT を JSON 化したもの */
  nbt: Record<string, unknown>;
}

export interface Extracted {
  dataVersion: number | undefined;
  dimensions: string[];
  commandBlocks: CommandBlockInfo[];
  chains: CommandBlockInfo[][];
  orphanChainBlocks: CommandBlockInfo[];
  scores: ObjectiveScores[];
  /** `名前空間:パス` → 値（JSON 化） */
  storage: Record<string, unknown>;
  entities: ExtractedEntity[];
}

export interface ExtractOptions {
  /** エンティティも読むか（大きなワールドでは時間がかかる。既定 true） */
  entities?: boolean;
  /**
   * ブロックの既定の状態（loadBlockDefaults で作る）。26.x では既定値の状態が省かれて保存されるため、
   * ないと向きが既定値（north）のコマンドブロックの facing が undefined になり、チェーンをたどれない
   */
  blockDefaults?: BlockDefaults;
}

export function extractWorld(dir: string, opts: ExtractOptions = {}): Extracted {
  const world = new JavaWorld(dir);
  const dimensions = world.dimensions();
  const commandBlocks: CommandBlockInfo[] = [];
  for (const dim of dimensions) {
    for (const chunk of world.chunks(dim)) commandBlocks.push(...commandBlocksInChunk(chunk, dim, opts.blockDefaults));
  }
  const { chains, orphans } = buildChains(commandBlocks);
  const entities: ExtractedEntity[] = [];
  if (opts.entities !== false) {
    for (const dim of dimensions) for (const e of world.entities(dim)) entities.push({ dimension: dim, nbt: nbtToPlain(e) as Record<string, unknown> });
  }
  return {
    dataVersion: world.dataVersion(),
    dimensions,
    commandBlocks,
    chains,
    orphanChainBlocks: orphans,
    scores: world.scoreboard(),
    storage: Object.fromEntries([...world.storage()].map(([k, v]) => [k, nbtToPlain(v)])),
    entities,
  };
}
