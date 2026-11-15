// そろえた結果どうしを比べ、差分と比べられなかった値を返す。サーバーに依存しない純粋な関数。
import type { CompareResult, Diff, NormalizedState } from "./types.ts";

function compareMaps<T>(prefix: string, java: Record<string, T> | undefined, bedrock: Record<string, T> | undefined, diffs: Diff[], incomparable?: string[]): void {
  const keys = new Set([...Object.keys(java ?? {}), ...Object.keys(bedrock ?? {})]);
  for (const k of [...keys].sort()) {
    const j = java?.[k];
    const b = bedrock?.[k];
    if (b !== null && typeof b === "object" && "unmapped" in (b as object)) {
      incomparable?.push(`${prefix}.${k}: ${(b as unknown as { unmapped: string }).unmapped}`);
      continue;
    }
    if (JSON.stringify(j) !== JSON.stringify(b)) diffs.push({ path: `${prefix}.${k}`, java: j, bedrock: b });
  }
}

export function compareStates(java: NormalizedState, bedrock: NormalizedState): CompareResult {
  const diffs: Diff[] = [];
  const incomparable: string[] = [];
  for (const obj of new Set([...Object.keys(java.scores ?? {}), ...Object.keys(bedrock.scores ?? {})])) {
    compareMaps(`scores.${obj}`, java.scores?.[obj], bedrock.scores?.[obj], diffs);
  }
  compareMaps("blocks", java.blocks, bedrock.blocks, diffs, incomparable);
  compareMaps("entities", java.entities, bedrock.entities, diffs);
  return { diffs, incomparable };
}

/** 既知の差分を除いた、説明のない差分 */
export function unexpectedDiffs(result: CompareResult, known: Record<string, string> = {}): Diff[] {
  return result.diffs.filter((d) => !(d.path in known));
}

export function formatDiffs(diffs: Diff[]): string {
  return diffs.map((d) => `  ${d.path}: java=${JSON.stringify(d.java)} bedrock=${JSON.stringify(d.bedrock)}`).join("\n");
}
