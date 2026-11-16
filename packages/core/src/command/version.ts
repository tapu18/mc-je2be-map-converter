// 版による書き方の違い。
import type { TextFormat } from "./arguments.ts";

/**
 * テキスト（minecraft:component）の書き方が JSON から SNBT に変わった最初の DataVersion（1.21.5）。
 * 1.21.4 / 1.21.5 の実サーバーで確認（#58、versioned-grammar.servers.test.ts）。
 */
export const SNBT_TEXT_DATA_VERSION = 4325;
export const SNBT_TEXT_PACK_FORMAT = 71;

/** DataVersion、なければ単体パックの形式から選ぶ。両方不明な手動指定時は最新（SNBT）。 */
export function textFormatFor(dataVersion: number | undefined, packFormat?: number): TextFormat {
  if (dataVersion !== undefined) return dataVersion < SNBT_TEXT_DATA_VERSION ? "json" : "snbt";
  return packFormat !== undefined && packFormat < SNBT_TEXT_PACK_FORMAT ? "json" : "snbt";
}
