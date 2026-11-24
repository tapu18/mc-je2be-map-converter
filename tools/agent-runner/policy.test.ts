import { describe, expect, it } from 'vitest';
import { activeClaims, baseAllowsMerge, canMerge, checksFailed, dependencies } from './policy.ts';
import type { Issue, PullRequest } from './policy.ts';

const issue: Issue = { number: 7, title: 'test', body: '', state: 'OPEN', labels: [], comments: [] };
const runs = [{ headSha: 'abc', event: 'pull_request', status: 'completed', conclusion: 'success' }];
const passing = (): PullRequest => ({
  number: 9, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: '7-test', headRefOid: 'abc',
  mergeStateStatus: 'CLEAN', reviewDecision: '', labels: [], closingIssuesReferences: [{ number: 7 }],
  statusCheckRollup: ['check', 'servers / result'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
});

describe('runner policy', () => {
  it('reads explicit dependencies without treating background links as blockers', () => {
    expect(dependencies('### 背景\nSee #99\n### 依存\n- #1\n- #2\n### メモ\nSee #98\nDepends on: #3, #1')).toEqual([1, 2, 3]);
  });
  it('tracks chronological claims and explicit cancellations', () => {
    expect(activeClaims([{ body: 'claim: first (branch a)' }, { body: 'claim: second (branch b)' },
      { body: 'claim-cancelled: first\nStopped' }])).toEqual(['second']);
  });
  it('requires a successful CI workflow for the current head, regardless of job names', () => {
    const pr = passing();
    expect(canMerge(issue, pr, 'main', runs)).toBe(true);
    expect(canMerge(issue, pr, 'main', [])).toBe(false);
    expect(canMerge(issue, pr, 'main', [{ ...runs[0]!, headSha: 'old' }])).toBe(false);
    expect(canMerge(issue, pr, 'main', [{ ...runs[0]!, event: 'push' }])).toBe(false);
    expect(canMerge(issue, pr, 'main', [{ ...runs[0]!, status: 'in_progress', conclusion: null }, ...runs])).toBe(false);
    expect(canMerge(issue, pr, 'main', [{ ...runs[0]!, conclusion: 'failure' }, ...runs])).toBe(false);
    pr.statusCheckRollup = [];
    expect(canMerge(issue, pr, 'main', runs)).toBe(false);
  });
  it('rejects pending, failed and duplicate stale checks', () => {
    for (const check of [
      { name: 'check', status: 'IN_PROGRESS', conclusion: '' },
      { name: 'extra', status: 'COMPLETED', conclusion: 'FAILURE' },
      { context: 'external', state: 'PENDING' },
    ]) {
      const pr = passing();
      pr.statusCheckRollup.push(check);
      expect(canMerge(issue, pr, 'main', runs)).toBe(false);
    }
  });
  it('accepts an aggregate result with no selected jobs or a successful subset', () => {
    expect(canMerge(issue, passing(), 'main', runs)).toBe(true);
    const pr = passing();
    pr.statusCheckRollup.push({ name: 'servers / scenarios-1', status: 'COMPLETED', conclusion: 'SUCCESS' });
    expect(canMerge(issue, pr, 'main', runs)).toBe(true);
    pr.statusCheckRollup[1]!.conclusion = 'FAILURE';
    expect(canMerge(issue, pr, 'main', runs)).toBe(false);
  });
  it('never merges approval waits, drafts, unlinked PRs, conflicting PRs or stacked PRs', () => {
    expect(canMerge({ ...issue, labels: [{ name: 'needs-approval' }] }, passing(), 'main', runs)).toBe(false);
    for (const override of [
      { labels: [{ name: 'needs-approval' }] }, { isDraft: true }, { closingIssuesReferences: [] },
      { baseRefName: 'other' }, { mergeStateStatus: 'DIRTY' }, { reviewDecision: 'CHANGES_REQUESTED' },
    ]) expect(canMerge(issue, { ...passing(), ...override }, 'main', runs)).toBe(false);
  });
  it('distinguishes failed CI from absent or pending CI', () => {
    expect(checksFailed({ ...passing(), statusCheckRollup: [] })).toBe(false);
    expect(checksFailed({ ...passing(), statusCheckRollup: [{ conclusion: 'FAILURE' }] })).toBe(true);
  });
});

describe('base merge safety', () => {
  const success = { headSha: 'base', event: 'push', status: 'completed', conclusion: 'success' };
  it('blocks a failed latest completed push, ignoring cancelled and pending runs', () => {
    expect(baseAllowsMerge([{ ...success, status: 'in_progress', conclusion: null },
      { ...success, conclusion: 'cancelled' }, { ...success, conclusion: 'failure' }, success], [], [])).toBe(false);
    expect(baseAllowsMerge([], [], [])).toBe(false);
    expect(baseAllowsMerge([success], [], [])).toBe(true);
  });
  it('blocks overlapping changes until the branch includes the base', () => {
    expect(baseAllowsMerge([success], ['shared'], ['shared'])).toBe(false);
    expect(baseAllowsMerge([success], ['base'], ['pr'])).toBe(true);
    expect(baseAllowsMerge([success], [], ['shared'])).toBe(true);
  });
});
