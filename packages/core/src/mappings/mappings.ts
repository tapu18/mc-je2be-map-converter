// 対応表の参照。Node・DOM に依存せず、ゲーム内でも同じ JSON を使う。
export interface JavaBlockState {
  id: string;
  states: Record<string, string>;
}

export interface BedrockBlockState {
  id: string;
  /** 表に明示された状態。BDS が補う既定値を網羅しているとは限らない。 */
  states: Record<string, string | number | boolean>;
}

export interface BlockMapping {
  java: JavaBlockState;
  bedrock: BedrockBlockState;
}

export interface ItemMapping {
  javaId: string;
  bedrockId: string;
  data?: number;
}

export interface MappingTables {
  schemaVersion: 1;
  source: {
    repository: string;
    revision: string;
    javaVersion: string;
    bedrockVersion: string;
    /** 元ファイルと、状態 ID の順序を復元する JE レポートの SHA-256。 */
    sha256: Record<string, string>;
  };
  blocks: BlockMapping[];
  items: ItemMapping[];
  /** 旧版の生成表にはコマンド用の ID 表がない。 */
  sounds?: Record<string, string>;
  particles?: Record<string, string>;
}

/** キー順と値の型を保持する。JE の部分条件の変換には使わない。 */
export function blockStateKey(block: JavaBlockState | BedrockBlockState): string {
  return JSON.stringify([block.id, Object.keys(block.states).sort().map((k) => [k, block.states[k]])]);
}

export type BlockMappingResult =
  | { status: "mapped"; target: BedrockBlockState; sharedBy: number; waterlogged: boolean; verification: "unverified" }
  | { status: "unknown-block" | "incomplete-state" | "unknown-state" };

/**
 * ブロックの条件（`execute if block` などの部分的な状態）の対応。
 * BE の条件（指定した状態だけを比べる。BDS 1.26.63.1 で実測、#62）が、同じ Java のブロックのうち
 * Java の条件に一致する状態だけ（表の上で）に一致するときに mapped にする。
 */
export type BlockPredicateMappingResult =
  | { status: "mapped"; target: BedrockBlockState; verification: "unverified" }
  | { status: "unknown-block" | "unknown-state" }
  /** BE の条件で書くと、同じ Java のブロックの、Java の条件に一致しない状態まで一致してしまう */
  | { status: "inexact" };

export type ItemMappingResult =
  | { status: "mapped"; target: ItemMapping; sharedBy: number; verification: "unverified" }
  | { status: "unknown-item" };

/** mapped は表に行があるという意味であり、挙動が等価という判定ではない。 */
export class MappingLookup {
  private blocks = new Map<string, BlockMapping>();
  private rowsByJava = new Map<string, BlockMapping[]>();
  private rowsByBedrock = new Map<string, BlockMapping[]>();
  private properties = new Map<string, string[]>();
  private blockTargets = new Map<string, number>();
  private items = new Map<string, ItemMapping>();
  private itemTargets = new Map<string, number>();
  private sounds: ReadonlyMap<string, string>;
  private particles: ReadonlyMap<string, string>;

  constructor(tables: MappingTables) {
    if (tables.schemaVersion !== 1) throw new Error("unsupported mapping schema");
    this.sounds = new Map(Object.entries(tables.sounds ?? {}));
    this.particles = new Map(Object.entries(tables.particles ?? {}));
    for (const row of tables.blocks) {
      const key = blockStateKey(row.java);
      if (this.blocks.has(key)) throw new Error(`duplicate Java block state: ${key}`);
      this.blocks.set(key, row);
      this.rowsByJava.set(row.java.id, [...(this.rowsByJava.get(row.java.id) ?? []), row]);
      this.rowsByBedrock.set(row.bedrock.id, [...(this.rowsByBedrock.get(row.bedrock.id) ?? []), row]);
      const props = Object.keys(row.java.states).sort();
      const previous = this.properties.get(row.java.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(props)) throw new Error(`inconsistent properties: ${row.java.id}`);
      this.properties.set(row.java.id, props);
      const target = blockStateKey(row.bedrock);
      this.blockTargets.set(target, (this.blockTargets.get(target) ?? 0) + 1);
    }
    for (const row of tables.items) {
      if (this.items.has(row.javaId)) throw new Error(`duplicate Java item: ${row.javaId}`);
      this.items.set(row.javaId, row);
      const key = JSON.stringify([row.bedrockId, row.data ?? 0]);
      this.itemTargets.set(key, (this.itemTargets.get(key) ?? 0) + 1);
    }
  }

  block(id: string, states: Record<string, string> = {}): BlockMappingResult {
    const props = this.properties.get(id);
    if (!props) return { status: "unknown-block" };
    if (Object.keys(states).some((k) => !props.includes(k))) return { status: "unknown-state" };
    if (props.some((k) => !Object.hasOwn(states, k))) return { status: "incomplete-state" };
    const row = this.blocks.get(blockStateKey({ id, states }));
    if (!row) return { status: "unknown-state" };
    return {
      status: "mapped", target: row.bedrock,
      sharedBy: this.blockTargets.get(blockStateKey(row.bedrock))!,
      waterlogged: states.waterlogged === "true", verification: "unverified",
    };
  }

  /** Java の状態の名前（表にある順ではなく名前順）。表にないブロックは undefined */
  blockProperties(id: string): string[] | undefined {
    return this.properties.get(id);
  }

  /** Java のブロックの条件（指定した状態だけを比べる）を、BE の条件に変える */
  blockPredicate(id: string, states: Record<string, string> = {}): BlockPredicateMappingResult {
    const props = this.properties.get(id);
    if (!props) return { status: "unknown-block" };
    if (Object.keys(states).some((k) => !props.includes(k))) return { status: "unknown-state" };
    const matches = (this.rowsByJava.get(id) ?? []).filter((r) => Object.entries(states).every(([k, v]) => r.java.states[k] === v));
    if (matches.length === 0) return { status: "unknown-state" };
    const first = matches[0]!.bedrock;
    if (matches.some((r) => r.bedrock.id !== first.id)) return { status: "inexact" };
    // 一致するすべての状態に共通する BE の状態だけを条件にする
    const common: BedrockBlockState["states"] = {};
    for (const [k, v] of Object.entries(first.states)) if (matches.every((r) => r.bedrock.states[k] === v)) common[k] = v;
    // その BE の条件が、同じ Java のブロックの、Java の条件に一致しない状態まで拾わないか。
    // 別の Java のブロックが同じ BE のブロックになるもの（cave_air → air など）は、変換後の BE では見分けられないため問わない
    const picked = (this.rowsByBedrock.get(first.id) ?? []).filter((r) => r.java.id === id && Object.entries(common).every(([k, v]) => r.bedrock.states[k] === v));
    const wanted = new Set(matches);
    if (picked.some((r) => !wanted.has(r))) return { status: "inexact" };
    return { status: "mapped", target: { id: first.id, states: common }, verification: "unverified" };
  }

  sound(id: string): string | undefined {
    return this.sounds.get(id);
  }

  particle(id: string): string | undefined {
    return this.particles.get(id);
  }

  item(id: string): ItemMappingResult {
    const row = this.items.get(id);
    if (!row) return { status: "unknown-item" };
    return { status: "mapped", target: row, sharedBy: this.itemTargets.get(JSON.stringify([row.bedrockId, row.data ?? 0]))!, verification: "unverified" };
  }
}
