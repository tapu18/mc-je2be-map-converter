import { describe, expect, it } from 'vitest';
import { activeClaims, canMerge, checksFailed, dependencies, requiredChecks } from './policy.ts';
import type { Issue, PullRequest } from './policy.ts';

const issue: Issue = { number: 7, title: 'test', body: '', state: 'OPEN', labels: [], comments: [] };
const passing = (): PullRequest => ({
  number: 9, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: '7-test', headRefOid: 'abc',
  mergeStateStatus: 'CLEAN', reviewDecision: '', labels: [], closingIssuesReferences: [{ number: 7 }],
  statusCheckRollup: requiredChecks.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
});

describe('runner policy', () => {
  it('reads explicit dependencies without treating background links as blockers', () => {
    expect(dependencies('### 背景\nSee #99\n### 依存\n- #1\n- #2\n### メモ\nSee #98\nDepends on: #3, #1')).toEqual([1, 2, 3]);
  });
  it('tracks chronological claims and explicit cancellations', () => {
    expect(activeClaims([{ body: 'claim: first (branch a)' }, { body: 'claim: second (branch b)' },
      { body: 'claim-cancelled: first\nStopped' }])).toEqual(['second']);
  });
  it('requires all repository checks, including checks that have not registered yet', () => {
    const pr = passing();
    expect(canMerge(issue, pr, 'main')).toBe(true);
    pr.statusCheckRollup.pop();
    expect(canMerge(issue, pr, 'main')).toBe(false);
    pr.statusCheckRollup = [];
    expect(canMerge(issue, pr, 'main')).toBe(false);
  });
  it('rejects pending, failed and duplicate stale checks', () => {
    for (const check of [
      { name: requiredChecks[0]!, status: 'IN_PROGRESS', conclusion: '' },
      { name: 'extra', status: 'COMPLETED', conclusion: 'FAILURE' },
      { context: 'external', state: 'PENDING' },
    ]) {
      const pr = passing();
      pr.statusCheckRollup.push(check);
      expect(canMerge(issue, pr, 'main')).toBe(false);
    }
  });
  it('accepts an aggregate result with no selected jobs or a successful subset', () => {
    expect(canMerge(issue, passing(), 'main')).toBe(true);
    const pr = passing();
    pr.statusCheckRollup.push({ name: 'servers / scenarios-1', status: 'COMPLETED', conclusion: 'SUCCESS' });
    expect(canMerge(issue, pr, 'main')).toBe(true);
    pr.statusCheckRollup[1]!.conclusion = 'FAILURE';
    expect(canMerge(issue, pr, 'main')).toBe(false);
  });
  it('never merges approval waits, drafts, unlinked PRs, conflicting PRs or stacked PRs', () => {
    expect(canMerge({ ...issue, labels: [{ name: 'needs-approval' }] }, passing(), 'main')).toBe(false);
    for (const override of [
      { labels: [{ name: 'needs-approval' }] }, { isDraft: true }, { closingIssuesReferences: [] },
      { baseRefName: 'other' }, { mergeStateStatus: 'DIRTY' }, { reviewDecision: 'CHANGES_REQUESTED' },
    ]) expect(canMerge(issue, { ...passing(), ...override }, 'main')).toBe(false);
  });
  it('distinguishes failed CI from absent or pending CI', () => {
    expect(checksFailed({ ...passing(), statusCheckRollup: [] })).toBe(false);
    expect(checksFailed({ ...passing(), statusCheckRollup: [{ conclusion: 'FAILURE' }] })).toBe(true);
  });
});
