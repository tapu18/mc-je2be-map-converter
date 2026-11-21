import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { summarizeEvaluation, validateEvaluation, type Evaluation, type GimmickEvaluation } from "./evaluation.ts";

const gimmick = (changes: Partial<GimmickEvaluation> = {}): GimmickEvaluation => ({
  id: "required", scenario: "fixture/scenario", start: "ready", steps: ["trigger"], successCriteria: ["score matches"],
  requiredFeatures: ["score"], required: true, status: "passed", evidence: ["unit fixture"], knownDiffs: [], incomparable: [],
  fixes: [], warnings: [], failures: [], ...changes,
});
const record = (gimmicks = [gimmick()]): Evaluation => ({ schemaVersion: 1, mapId: "unit-fixture", kind: "observed", scope: "client-playthrough",
  staticReport: null, completion: { status: "passed", evidence: ["unit fixture completion"] }, gimmicks });

describe("gimmick evaluation", () => {
  it("validates both published examples without claiming client completion", () => {
    for (const name of ["scores-chain.observed", "required-gate.illustrative"]) {
      const value: unknown = JSON.parse(readFileSync(new URL(`../../../evaluations/${name}.json`, import.meta.url), "utf8"));
      validateEvaluation(value);
      expect(summarizeEvaluation(value).clearConfirmed).toBe(false);
    }
  });
  it("keeps an unverified mandatory gimmick out of success and clear confirmation", () => {
    const result = summarizeEvaluation(record([gimmick(), gimmick({ id: "blocking", status: "unverified", evidence: [], requiredFeatures: ["display entity"] })]));
    expect(result.counts).toEqual({ passed: 1, "passed-after-manual-fix": 0, unverified: 1, failed: 0 });
    expect(result.automaticSuccessRate).toBe(0.5);
    expect(result.blockers).toEqual([{ id: "blocking", status: "unverified", features: ["display entity"] }]);
    expect(result.clearConfirmed).toBe(false);
  });
  it("requires evidence, complete comparison, a client run and explicit completion", () => {
    expect(summarizeEvaluation(record()).clearConfirmed).toBe(true);
    for (const changes of [{ evidence: [] }, { incomparable: ["required block"] }, { failures: [{ location: "gate", reason: "failed", priorWarningIds: [], warningAssessment: "missed" as const }] }]) {
      const result = summarizeEvaluation(record([gimmick(changes)]));
      expect(result.counts.unverified).toBe(1);
      expect(result.clearConfirmed).toBe(false);
    }
    const e = record(); e.scope = "server-scenario";
    expect(summarizeEvaluation(e).clearConfirmed).toBe(false);
    e.scope = "client-playthrough"; e.completion.status = "unverified";
    expect(summarizeEvaluation(e).clearConfirmed).toBe(false);
  });
  it("does not turn empty or illustrative records into 100 percent", () => {
    expect(summarizeEvaluation(record([]))).toMatchObject({ automaticSuccessRate: null, warningCoverageRate: null, clearConfirmed: false });
    const e = record(); e.kind = "illustrative";
    expect(summarizeEvaluation(e)).toMatchObject({ counts: { unverified: 1 }, automaticSuccessRate: null, clearConfirmed: false });
  });
  it("separates verified manual repairs from automatic success and candidates", () => {
    const repair = { location: "gate", reason: "missing", procedure: "edit", reapplyAfterConversion: "yes" as const, verification: "candidate" as const, evidence: [] };
    const e = record([gimmick({ status: "passed-after-manual-fix", fixes: [repair] })]);
    expect(summarizeEvaluation(e).counts.unverified).toBe(1);
    e.gimmicks[0]!.fixes = [{ ...repair, verification: "verified", evidence: ["unit repair run"] }];
    expect(summarizeEvaluation(e)).toMatchObject({ automaticSuccessRate: 0, successIncludingManualFixRate: 1, counts: { "passed-after-manual-fix": 1 } });
  });
  it("counts observed failures with missed and unverified warning checks in the denominator", () => {
    const e = record([gimmick({ status: "failed", warnings: [{ id: "w", location: "gate", message: "unsupported" }], failures: [
      { location: "gate", reason: "first", priorWarningIds: ["w"], warningAssessment: "warned" },
      { location: "gate", reason: "second", priorWarningIds: [], warningAssessment: "missed" },
      { location: "gate", reason: "third", priorWarningIds: [], warningAssessment: "unverified" },
    ], knownDiffs: ["visual difference"] })]);
    expect(summarizeEvaluation(e)).toMatchObject({ warningCoverage: { warned: 1, missed: 1, unverified: 1 }, warningCoverageRate: 1 / 3, knownDiffs: 1, clearConfirmed: false });
    e.gimmicks[0]!.failures[0]!.priorWarningIds = ["nonexistent"];
    expect(() => validateEvaluation(e)).toThrow(/invalid evaluation/);
  });
  it("rejects duplicate IDs and incomplete records", () => {
    expect(() => validateEvaluation(record([gimmick(), gimmick()]))).toThrow();
    expect(() => validateEvaluation({ schemaVersion: 1 })).toThrow();
    expect(() => validateEvaluation(record([gimmick({ successCriteria: [] })]))).toThrow();
  });
});
