import type { TextFormat } from "./arguments.ts";

export interface CommandGrammar {
  version: string;
  dataVersion: number;
  packFormat: number;
  textFormat: TextFormat;
  /** 同じ pack_format を複数の版が使う場合、実際に同じ文法かを確かめたハッシュ。 */
  commandsSha256?: string;
}

export type GrammarSelection<T> =
  | { ok: true; grammar: T; matchedBy: "data-version" | "pack-format" }
  | { ok: false; reason: "unavailable" | "ambiguous"; message: string };

/** 正確に分かる版だけを選ぶ。近い版や最新版への暗黙のフォールバックはしない。 */
export function selectCommandGrammar<T extends CommandGrammar>(
  grammars: readonly T[], source: { dataVersion?: number; packFormat?: number },
): GrammarSelection<T> {
  const candidates = source.dataVersion !== undefined
    ? grammars.filter((g) => g.dataVersion === source.dataVersion)
    : grammars.filter((g) => source.packFormat !== undefined && g.packFormat === source.packFormat);
  if (candidates.length === 0) return { ok: false, reason: "unavailable", message: "対象版の文法がない。対応する Java サーバーから文法を生成する必要がある" };
  const first = candidates[0]!;
  if (candidates.length !== 1 && (!first.commandsSha256 || candidates.some((g) => g.commandsSha256 !== first.commandsSha256 || g.textFormat !== first.textFormat))) {
    return { ok: false, reason: "ambiguous", message: "同じ pack_format に異なる文法があるため DataVersion が必要" };
  }
  // ワールドの DataVersion を優先する。併用されるパックの pack_format は古いこともある。
  const grammar = [...candidates].sort((a, b) => b.dataVersion - a.dataVersion)[0]!;
  return { ok: true, grammar, matchedBy: source.dataVersion === undefined ? "pack-format" : "data-version" };
}
