// BEの .mcstructure（リトルエンディアンNBT）の生成。
// 形式: format_version, size, structure{block_indices[2層], entities, palette.default{block_palette, block_position_data}}, structure_world_origin
import { nbt, writeNbt, type NbtCompound, type NbtTag } from "../nbt/nbt.ts";

export type BlockStateValue = string | number | boolean;

export interface StructureBlock {
  pos: [number, number, number];
  name: string;
  states?: Record<string, BlockStateValue>;
  /** ブロックエンティティのNBT（コマンドブロックなど） */
  blockEntity?: NbtCompound;
}

export interface StructureSpec {
  size: [number, number, number];
  blocks: StructureBlock[];
  /** 空いた位置を空気で埋めるか（false なら読み込み時に既存ブロックを残す） */
  fillAir?: boolean;
  /** ブロックパレットの version。BEが古い値を見ると移行処理をかけるため、出力先に合わせる */
  blockVersion?: number;
}

// BDS 1.26.63.1 が保存した値。製品バージョンから計算しない（poc/mcstructure-version/）。
export const DEFAULT_BLOCK_VERSION = 18168865; // 0x01153c21

function stateTag(v: BlockStateValue): NbtTag {
  if (typeof v === "string") return nbt.string(v);
  if (typeof v === "boolean") return nbt.byte(v ? 1 : 0);
  return nbt.int(v);
}

function paletteKey(name: string, states: Record<string, BlockStateValue>): string {
  return `${name}${JSON.stringify(Object.entries(states).sort(([a], [b]) => a.localeCompare(b)))}`;
}

export function buildMcstructure(spec: StructureSpec): Uint8Array {
  const [sx, sy, sz] = spec.size;
  const volume = sx * sy * sz;
  const version = spec.blockVersion ?? DEFAULT_BLOCK_VERSION;
  const palette: NbtTag[] = [];
  const paletteIndex = new Map<string, number>();
  const intern = (name: string, states: Record<string, BlockStateValue>): number => {
    const key = paletteKey(name, states);
    let i = paletteIndex.get(key);
    if (i === undefined) {
      i = palette.length;
      paletteIndex.set(key, i);
      const st = new Map<string, NbtTag>();
      for (const [k, v] of Object.entries(states)) st.set(k, stateTag(v));
      palette.push(nbt.compound({ name: nbt.string(name), states: nbt.compound(st), version: nbt.int(version) }));
    }
    return i;
  };

  const layer0 = new Array<number>(volume).fill(spec.fillAir === false ? -1 : intern("minecraft:air", {}));
  const layer1 = new Array<number>(volume).fill(-1);
  const positionData = new Map<string, NbtTag>();

  for (const b of spec.blocks) {
    const [x, y, z] = b.pos;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) throw new Error(`block out of bounds: ${b.pos}`);
    // z が最も速く変わる順
    const idx = (x * sy + y) * sz + z;
    layer0[idx] = intern(b.name, b.states ?? {});
    if (b.blockEntity) {
      const be = new Map(b.blockEntity.value);
      be.set("x", nbt.int(x));
      be.set("y", nbt.int(y));
      be.set("z", nbt.int(z));
      positionData.set(String(idx), nbt.compound({ block_entity_data: nbt.compound(be) }));
    }
  }

  const ints = (a: number[]): NbtTag => nbt.list("int", a.map((v) => nbt.int(v)));
  const root = nbt.compound({
    format_version: nbt.int(1),
    size: ints([sx, sy, sz]),
    structure: nbt.compound({
      block_indices: nbt.list("list", [ints(layer0), ints(layer1)]),
      entities: nbt.list("compound", []),
      palette: nbt.compound({
        default: nbt.compound({
          block_palette: nbt.list("compound", palette),
          block_position_data: nbt.compound(positionData),
        }),
      }),
    }),
    structure_world_origin: ints([0, 0, 0]),
  });
  return writeNbt({ name: "", tag: root }, "bedrock");
}

// ---- コマンドブロック ----

export type CommandBlockKind = "impulse" | "chain" | "repeat";

/** BEの facing_direction: 0=下, 1=上, 2=北(-Z), 3=南(+Z), 4=西(-X), 5=東(+X) */
export type Facing = 0 | 1 | 2 | 3 | 4 | 5;

export interface CommandBlockSpec {
  pos: [number, number, number];
  kind: CommandBlockKind;
  command: string;
  facing: Facing;
  conditional?: boolean;
  /** 常時実行（true）か、レッドストーン必要（false） */
  alwaysActive?: boolean;
  tickDelay?: number;
  customName?: string;
  /** BEのコマンドブロックの Version。古い値だと旧構文で解釈される。実機で確認した値に合わせる */
  version?: number;
}

const BLOCK_NAMES: Record<CommandBlockKind, string> = {
  impulse: "minecraft:command_block",
  chain: "minecraft:chain_command_block",
  repeat: "minecraft:repeating_command_block",
};

// BDS が setblock で新規作成した3種類すべてで確認（poc/mcstructure-version/）。
export const DEFAULT_COMMAND_BLOCK_VERSION = 55;

export function commandBlock(spec: CommandBlockSpec): StructureBlock {
  const mode = spec.kind === "impulse" ? 0 : spec.kind === "repeat" ? 1 : 2;
  return {
    pos: spec.pos,
    name: BLOCK_NAMES[spec.kind],
    states: { facing_direction: spec.facing, conditional_bit: spec.conditional ?? false },
    blockEntity: nbt.compound({
      id: nbt.string("CommandBlock"),
      Command: nbt.string(spec.command),
      CustomName: nbt.string(spec.customName ?? ""),
      ExecuteOnFirstTick: nbt.byte(1),
      LPCommandMode: nbt.int(mode),
      LPCondionalMode: nbt.byte(spec.conditional ? 1 : 0), // BE側のキー名の綴りのまま
      LPRedstoneMode: nbt.byte(spec.alwaysActive ? 0 : 1),
      LastExecution: nbt.long(0n),
      LastOutput: nbt.string(""),
      LastOutputParams: nbt.list("string", []),
      SuccessCount: nbt.int(0),
      TickDelay: nbt.int(spec.tickDelay ?? 0),
      TrackOutput: nbt.byte(1),
      Version: nbt.int(spec.version ?? DEFAULT_COMMAND_BLOCK_VERSION),
      auto: nbt.byte(spec.alwaysActive ? 1 : 0),
      conditionMet: nbt.byte(0),
      conditionalMode: nbt.byte(spec.conditional ? 1 : 0),
      isMovable: nbt.byte(1),
      powered: nbt.byte(0),
    }),
  };
}
