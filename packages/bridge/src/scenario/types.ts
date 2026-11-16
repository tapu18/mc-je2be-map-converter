// 正解データのシナリオの形式（#38）。scenarios/<分類>/<名前>.json に置く。
// Java 版サーバーで実行した結果を正解として <名前>.java.json に保存し、BE で実行した結果と比べる。

export type Vec3 = [number, number, number];

export type CommandBlockKind = "impulse" | "chain" | "repeat";
/** 向き（Java の facing と同じ名前） */
export type Facing = "down" | "up" | "north" | "south" | "west" | "east";

export interface ScenarioCommandBlock {
  pos: Vec3;
  kind: CommandBlockKind;
  facing: Facing;
  command: string;
  conditional?: boolean;
  /** 常時実行（既定 true） */
  alwaysActive?: boolean;
}

export type Action =
  /** コマンドを1つ実行する（先頭の / は不要） */
  | { run: string }
  /** 指定 tick だけ進める。Java は /tick step で決定的に、BE は実時間で待つ */
  | { ticks: number }
  /** コマンドブロックを置く。Java は setblock、BE は .mcstructure で置く */
  | { commandBlocks: ScenarioCommandBlock[] };

export interface Observe {
  /** 見るスコアの目的変数 */
  scores?: string[];
  /** 見るブロックの範囲（両端を含む） */
  blocks?: { from: Vec3; to?: Vec3 }[];
  /** 見るエンティティ（このタグのどれかを持つもの） */
  entityTags?: string[];
}

export interface EditionSteps {
  setup?: string[];
  actions?: Action[];
}

export interface Scenario {
  /** ファイル名から付ける（JSON には書かなくてよい） */
  id?: string;
  description: string;
  /** 初期化。読み込み範囲（0..63）の中で行う */
  setup: string[];
  actions: Action[];
  observe: Observe;
  /**
   * 変換を通すシナリオ（#61）。書いたときは、Java で setup と actions まで行ったワールドを保存して変換器に通し、
   * BE はその変換後のワールドから play を行う。Java は同じセッションのまま play を続ける。
   * BE で行う操作を変えたいときは bedrock ではなく変換器を直す（併用はできない）
   */
  play?: Action[];
  /** BE で実行する内容を変える場合（変換器ができるまでの手書きの対応）。省略時は同じものを実行する */
  bedrock?: EditionSteps;
  /** 既知の差分（調査済みのもの）。パスごとに理由を書く。ここにない差分はテストの失敗になる */
  knownDiffs?: Record<string, string>;
}

/** 両エディションの結果をそろえた形。比較はこの形どうしで行う */
export interface NormalizedState {
  /** 目的変数 → 参加者 → 値 */
  scores?: Record<string, Record<string, number>>;
  /** "x,y,z" → Java 形式のブロック（"minecraft:stone"、"minecraft:oak_stairs[facing=east,half=top]"）。対応がなければ undefined */
  blocks?: Record<string, string | { unmapped: string }>;
  /** "種類 タグ1,タグ2" → 数 */
  entities?: Record<string, number>;
}

export interface Diff {
  path: string;
  java: unknown;
  bedrock: unknown;
}

export interface CompareResult {
  diffs: Diff[];
  /** 対応表がなく比べられなかった値 */
  incomparable: string[];
}
