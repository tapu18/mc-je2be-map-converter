// 両エディションの観測結果を、比較できる同じ形（NormalizedState）にそろえる。サーバーに依存しない純粋な関数。
import type { EntityPose, NormalizedState, Observe } from "./types.ts";

export interface RawScores {
  objective: string;
  scores: { participant: string; score: number }[];
}

export interface RawBlock {
  pos: number[];
  type: string | null;
  states?: Record<string, unknown>;
}

export interface RawEntity {
  type: string;
  tags: string[];
  pos?: number[];
  /** [ピッチ, ヨー] */
  rot?: number[];
  nameTag?: string;
  scores?: Record<string, number>;
}

/**
 * BE のブロックを Java 形式の文字列に変える関数。対応がわからなければ undefined を返す。
 * ID 対応表（#14）ができるまでは、状態を持たない同名ブロックだけを対応させる既定の関数を使う。
 */
export type BedrockBlockMapper = (type: string, states: Record<string, unknown>) => string | undefined;

/** 同名で、BE 側にも Java 側にも状態がない（と分かっている）ブロックだけを対応させる */
export const minimalBlockMapper: BedrockBlockMapper = (type, states) => {
  const SAME_NAME_NO_STATE = new Set([
    "minecraft:air", "minecraft:gold_block", "minecraft:diamond_block", "minecraft:iron_block", "minecraft:emerald_block",
    "minecraft:glass", "minecraft:bedrock", "minecraft:obsidian",
  ]);
  if (!SAME_NAME_NO_STATE.has(type)) return undefined;
  // BE では状態を持たないはずのブロックに状態があれば、対応が分からないものとして扱う
  return Object.keys(states).length === 0 ? type : undefined;
};

export function javaBlockString(type: string, states: Record<string, string>): string {
  const keys = Object.keys(states).sort();
  return keys.length === 0 ? type : `${type}[${keys.map((k) => `${k}=${states[k]}`).join(",")}]`;
}

const posKey = (p: number[]): string => p.slice(0, 3).join(",");
const entityKey = (e: RawEntity): string => `${e.type} ${[...e.tags].sort().join(",")}`;

function normalizeScores(raw: RawScores[], observe: Observe): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const objective of observe.scores ?? []) {
    const o = raw.find((r) => r.objective === objective);
    if (!o) continue;
    out[objective] = Object.fromEntries((o?.scores ?? []).map((s) => [s.participant, s.score]));
  }
  return out;
}

function normalizeEntities(raw: RawEntity[], observe: Observe): Record<string, number> {
  const tags = observe.entityTags ?? [];
  const out: Record<string, number> = {};
  for (const e of raw) {
    if (!e.tags.some((t) => tags.includes(t))) continue;
    const k = entityKey(e);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function normalizeEntityDetails(raw: RawEntity[], observe: Observe): NonNullable<NormalizedState["entityDetails"]> {
  const out: NonNullable<NormalizedState["entityDetails"]> = {};
  for (const e of raw) {
    if (!e.tags.some((t) => observe.entityTags?.includes(t)) || e.pos?.length !== 3 || e.nameTag === undefined) continue;
    const block = e.pos.map(Math.floor) as [number, number, number];
    const scores = Object.fromEntries(Object.entries(e.scores ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    (out[entityKey(e)] ??= []).push({ name: e.nameTag, block, scores });
  }
  for (const entities of Object.values(out)) entities.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return out;
}

const round = (v: number): number => Math.round(v * 1000) / 1000 + 0;
/** ヨーを -180 以上 180 未満にそろえる */
export const wrapYaw = (yaw: number): number => {
  const w = ((yaw + 180) % 360 + 360) % 360 - 180;
  return round(w);
};

function normalizePoses(raw: RawEntity[], tags: string[]): Record<string, EntityPose | null> {
  return Object.fromEntries(tags.map((tag) => {
    const found = raw.filter((e) => e.tags.includes(tag));
    if (found.length > 1) throw new Error(`entityPoses: タグ ${tag} のエンティティが ${found.length} 体ある（1体にする）`);
    const e = found[0];
    if (!e) return [tag, null];
    if (e.pos?.length !== 3 || e.rot?.length !== 2) throw new Error(`entityPoses: タグ ${tag} の座標か向きがない`);
    return [tag, { pos: e.pos.map(round) as [number, number, number], rot: [round(e.rot[0]!), wrapYaw(e.rot[1]!)] }];
  }));
}

export function normalizeJava(
  observe: Observe,
  raw: { scores?: RawScores[]; blocks?: { pos: number[]; type: string; states: Record<string, string> }[]; entities?: RawEntity[]; storage?: Record<string, unknown> },
): NormalizedState {
  const out: NormalizedState = {};
  if (observe.scores) out.scores = normalizeScores(raw.scores ?? [], observe);
  if (observe.storage) {
    const storage = raw.storage ?? {};
    out.storage = Object.fromEntries(observe.storage.filter((id) => Object.hasOwn(storage, id)).map((id) => [id, storage[id]]));
  }
  if (observe.blocks) out.blocks = Object.fromEntries((raw.blocks ?? []).map((b) => [posKey(b.pos), javaBlockString(b.type, b.states)]));
  if (observe.entityTags) out.entities = normalizeEntities(raw.entities ?? [], observe);
  if (observe.entityDetails) out.entityDetails = normalizeEntityDetails(raw.entities ?? [], observe);
  if (observe.entityPoses) out.entityPoses = normalizePoses(raw.entities ?? [], observe.entityPoses);
  return out;
}

function javaEntityType(e: RawEntity): RawEntity {
  const type = e.type === "minecraft:villager_v2" ? "minecraft:villager"
    : e.type === "minecraft:zombie_villager_v2" ? "minecraft:zombie_villager"
      : e.type === "minecraft:ender_crystal" ? "minecraft:end_crystal" : e.type;
  return { ...e, type };
}

export function normalizeBedrock(
  observe: Observe,
  raw: { scores?: RawScores[]; blocks?: RawBlock[]; entities?: RawEntity[] },
  mapBlock: BedrockBlockMapper = minimalBlockMapper,
): NormalizedState {
  const out: NormalizedState = {};
  if (observe.scores) out.scores = normalizeScores(raw.scores ?? [], observe);
  if (observe.blocks) {
    out.blocks = Object.fromEntries(
      (raw.blocks ?? []).map((b) => {
        const type = b.type ?? "<unloaded>";
        const states = b.states ?? {};
        const mapped = mapBlock(type, states);
        const shown = Object.keys(states).length ? `${type}${JSON.stringify(states)}` : type;
        return [posKey(b.pos), mapped ?? { unmapped: shown }];
      }),
    );
  }
  const entities = (raw.entities ?? []).map(javaEntityType);
  if (observe.entityTags) out.entities = normalizeEntities(entities, observe);
  if (observe.entityDetails) out.entityDetails = normalizeEntityDetails(entities, observe);
  if (observe.entityPoses) out.entityPoses = normalizePoses(entities, observe.entityPoses);
  return out;
}
