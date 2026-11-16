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

/** 必須の観測が欠落・比較不能なら、差分が0件でも成功としない。 */
export function assessComparison(java: NormalizedState, bedrock: NormalizedState, required: string[] = [], known: Record<string, string> = {}) {
  if (required.some(path => !path.trim()) || new Set(required).size !== required.length) throw new Error("required observations must be nonempty unique paths");
  const result = compareStates(java, bedrock);
  const values = (state: NormalizedState): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    const visit = (value: unknown, path: string): void => {
      if (value === undefined) return;
      out.set(path, value);
      if (value && typeof value === "object" && !("unmapped" in value)) for (const [key, v] of Object.entries(value)) visit(v, path ? `${path}.${key}` : key);
    };
    visit(state, "");
    return out;
  };
  const j = values(java), b = values(bedrock);
  const within = (path: string, parent: string): boolean => path === parent || path.startsWith(parent + ".");
  const checks = required.map(path => {
    const diffs = result.diffs.filter(d => within(d.path, path));
    const incomparable = result.incomparable.some(p => within(p.split(": ")[0]!, path));
    const status: "missing" | "incomparable" | "known-difference" | "different" | "matched" = !j.has(path) || !b.has(path) ? "missing" : incomparable ? "incomparable"
      : diffs.length ? diffs.every(d => d.path in known) ? "known-difference" : "different" : "matched";
    return { path, status };
  });
  const counts = { matched: 0, "known-difference": 0, different: 0, incomparable: 0, missing: 0 };
  for (const check of checks) counts[check.status]++;
  return {
    ...result, checks, required: counts,
    passed: unexpectedDiffs(result, known).length === 0 && counts.different === 0 && counts.incomparable === 0 && counts.missing === 0,
    completeMatch: required.length > 0 && counts.matched === required.length && result.diffs.length === 0 && result.incomparable.length === 0,
  };
}
