// 版による書き方の違い。
import type { TextFormat } from "./arguments.ts";

/**
 * テキスト（minecraft:component）の書き方が JSON から SNBT に変わった最初の DataVersion（1.21.5）。
 * 値は記憶による（未確認、#13 の後続で配布マップと実サーバーで確かめる）
 */
export const SNBT_TEXT_DATA_VERSION = 4325;

/** ワールドの DataVersion からテキストの書き方を決める。わからなければ最新（SNBT）とみなす */
export function textFormatFor(dataVersion: number | undefined): TextFormat {
  return dataVersion !== undefined && dataVersion < SNBT_TEXT_DATA_VERSION ? "json" : "snbt";
}
