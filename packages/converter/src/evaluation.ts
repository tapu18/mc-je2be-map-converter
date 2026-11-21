// 行数による静的集計とは別の、ギミック単位の観測記録（#69）。
export type GimmickStatus = "unverified" | "passed" | "passed-after-manual-fix" | "failed";
export interface ManualFix {
  location: string;
  reason: string;
  procedure: string;
  reapplyAfterConversion: "yes" | "no" | "unknown";
  verification: "candidate" | "verified";
  evidence: string[];
}
export interface GimmickEvaluation {
  id: string;
  scenario: string;
  start: string;
  steps: string[];
  successCriteria: string[];
  requiredFeatures: string[];
  required: boolean;
  status: GimmickStatus;
  evidence: string[];
  knownDiffs: string[];
  /** 成功条件のうち比較できなかった項目 */
  incomparable: string[];
  fixes: ManualFix[];
  warnings: { id: string; location: string; message: string }[];
  failures: { location: string; reason: string; priorWarningIds: string[]; warningAssessment: "warned" | "missed" | "unverified" }[];
}
export interface Evaluation {
  schemaVersion: 1;
  mapId: string;
  kind: "observed" | "illustrative";
  scope: "server-scenario" | "client-playthrough";
  /** パース率や静的振り分けは別資料への参照。成立率の分子・分母に混ぜない */
  staticReport: string | null;
  completion: { status: "unverified" | "passed" | "failed"; evidence: string[] };
  gimmicks: GimmickEvaluation[];
}

const statuses: GimmickStatus[] = ["unverified", "passed", "passed-after-manual-fix", "failed"];
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(nonempty);
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function fail(): never { throw new Error("invalid evaluation record; see docs/evaluation.md"); }

/** CLI用。入力の欠落・誤記を成功として扱わない。 */
export function validateEvaluation(v: unknown): asserts v is Evaluation {
  if (!object(v) || v.schemaVersion !== 1 || !nonempty(v.mapId) || !["observed", "illustrative"].includes(String(v.kind))
    || !["server-scenario", "client-playthrough"].includes(String(v.scope)) || !(v.staticReport === null || nonempty(v.staticReport))
    || !object(v.completion) || !["unverified", "passed", "failed"].includes(String(v.completion.status)) || !strings(v.completion.evidence) || !Array.isArray(v.gimmicks)) fail();
  const ids = new Set<string>();
  for (const g of v.gimmicks) {
    if (!object(g) || ![g.id, g.scenario, g.start].every(nonempty) || ids.has(String(g.id)) || typeof g.required !== "boolean"
      || !statuses.includes(g.status as GimmickStatus) || ![g.steps, g.successCriteria, g.requiredFeatures, g.evidence, g.knownDiffs, g.incomparable].every(strings)
      || !(g.steps as string[]).length || !(g.successCriteria as string[]).length || !(g.requiredFeatures as string[]).length
      || !Array.isArray(g.fixes) || !Array.isArray(g.warnings) || !Array.isArray(g.failures)) fail();
    if (g.status === "failed" && !g.failures.length) fail();
    ids.add(g.id as string);
    for (const f of g.fixes) if (!object(f) || ![f.location, f.reason, f.procedure].every(nonempty)
      || !["yes", "no", "unknown"].includes(String(f.reapplyAfterConversion)) || !["candidate", "verified"].includes(String(f.verification)) || !strings(f.evidence)) fail();
    const warningIds = new Set<string>();
    for (const w of g.warnings) {
      if (!object(w) || ![w.id, w.location, w.message].every(nonempty) || warningIds.has(String(w.id))) fail();
      warningIds.add(w.id as string);
    }
    for (const f of g.failures) {
      if (!object(f) || ![f.location, f.reason].every(nonempty) || !strings(f.priorWarningIds)
        || !["warned", "missed", "unverified"].includes(String(f.warningAssessment))
        || f.priorWarningIds.some(id => !warningIds.has(id))
        || (f.warningAssessment === "warned" && !f.priorWarningIds.length)
        || (f.warningAssessment === "missed" && f.priorWarningIds.length)) fail();
    }
  }
}

/** 証拠・必須比較が不足した宣言は未検証に下げる。 */
export function effectiveStatus(evaluation: Evaluation, g: GimmickEvaluation): GimmickStatus {
  if (evaluation.kind !== "observed" || !g.evidence.length) return "unverified";
  if (g.status === "failed") return "failed";
  if (g.incomparable.length) return "unverified";
  if (g.status === "passed-after-manual-fix" && (!g.fixes.length || g.fixes.some(f => f.verification !== "verified" || !f.evidence.length))) return "unverified";
  if (g.status === "passed" && g.fixes.some(f => f.verification === "verified")) return "unverified";
  if ((g.status === "passed" || g.status === "passed-after-manual-fix") && g.failures.length) return "unverified";
  return g.status;
}

export function summarizeEvaluation(e: Evaluation) {
  validateEvaluation(e);
  const counts = { unverified: 0, passed: 0, "passed-after-manual-fix": 0, failed: 0 };
  const blockers: { id: string; status: GimmickStatus; features: string[] }[] = [];
  const warningCoverage = { warned: 0, missed: 0, unverified: 0 };
  for (const g of e.gimmicks) {
    const status = effectiveStatus(e, g);
    counts[status]++;
    if (g.required && (status === "failed" || status === "unverified")) blockers.push({ id: g.id, status, features: g.requiredFeatures });
    if (e.kind === "observed" && g.evidence.length) for (const f of g.failures) warningCoverage[f.warningAssessment]++;
  }
  const total = e.gimmicks.length;
  const failures = warningCoverage.warned + warningCoverage.missed + warningCoverage.unverified;
  return {
    mapId: e.mapId, kind: e.kind, scope: e.scope, staticReport: e.staticReport,
    total, counts, verified: total - counts.unverified,
    // 未検証も分母に含める。説明用の記録・分母0は達成率を出さない。
    automaticSuccessRate: e.kind === "observed" && total ? counts.passed / total : null,
    successIncludingManualFixRate: e.kind === "observed" && total ? (counts.passed + counts["passed-after-manual-fix"]) / total : null,
    knownDiffs: e.gimmicks.reduce((n, g) => n + g.knownDiffs.length, 0),
    incomparable: e.gimmicks.reduce((n, g) => n + g.incomparable.length, 0),
    blockers, warningCoverage,
    warningCoverageRate: e.kind === "observed" && failures ? warningCoverage.warned / failures : null,
    clearConfirmed: e.kind === "observed" && e.scope === "client-playthrough" && e.completion.status === "passed"
      && e.completion.evidence.length > 0 && e.gimmicks.some(g => g.required) && blockers.length === 0,
  };
}
