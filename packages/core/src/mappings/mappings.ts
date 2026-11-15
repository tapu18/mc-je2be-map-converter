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
}

/** キー順と値の型を保持する。JE の部分条件の変換には使わない。 */
export function blockStateKey(block: JavaBlockState | BedrockBlockState): string {
  return JSON.stringify([block.id, Object.keys(block.states).sort().map((k) => [k, block.states[k]])]);
}

export type BlockMappingResult =
  | { status: "mapped"; target: BedrockBlockState; sharedBy: number; waterlogged: boolean; verification: "unverified" }
  | { status: "unknown-block" | "incomplete-state" | "unknown-state" };

export type ItemMappingResult =
  | { status: "mapped"; target: ItemMapping; sharedBy: number; verification: "unverified" }
  | { status: "unknown-item" };

/** mapped は表に行があるという意味であり、挙動が等価という判定ではない。 */
export class MappingLookup {
  private blocks = new Map<string, BlockMapping>();
  private properties = new Map<string, string[]>();
  private blockTargets = new Map<string, number>();
  private items = new Map<string, ItemMapping>();
  private itemTargets = new Map<string, number>();

  constructor(tables: MappingTables) {
    if (tables.schemaVersion !== 1) throw new Error("unsupported mapping schema");
    for (const row of tables.blocks) {
      const key = blockStateKey(row.java);
      if (this.blocks.has(key)) throw new Error(`duplicate Java block state: ${key}`);
      this.blocks.set(key, row);
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

  item(id: string): ItemMappingResult {
    const row = this.items.get(id);
    if (!row) return { status: "unknown-item" };
    return { status: "mapped", target: row, sharedBy: this.itemTargets.get(JSON.stringify([row.bedrockId, row.data ?? 0]))!, verification: "unverified" };
  }
}
