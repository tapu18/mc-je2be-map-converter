import { expect, it } from 'vitest';
import { agentArguments, workerPrompt } from './agent.ts';

it('does not combine Codex automatic approval with an explicit sandbox', () => {
  const args = agentArguments('codex', ['--approve-for-me']);
  expect(args).toContain('--approve-for-me');
  expect(args).not.toContain('--sandbox');
  expect(args.at(-1)).toBe('-');
  expect(agentArguments('codex', [])).toContain('workspace-write');
  expect(agentArguments('codex', ['--sandbox=read-only'])).not.toContain('--sandbox');
  expect(() => agentArguments('codex', ['--approve-for-me', '--sandbox', 'workspace-write'])).toThrow('cannot be combined');
});

it('includes the actionable retry reasons and failed check names', () => {
  const task = { claim: 'worker', issue: 229, worktree: '/work', branch: 'branch', attempts: 2 };
  const item = { number: 229, title: '', body: '', state: 'OPEN', labels: [], comments: [] };
  const pr = { number: 42, state: 'OPEN', isDraft: true, baseRefName: 'main', headRefName: 'branch', headRefOid: 'sha', mergeStateStatus: 'DIRTY', reviewDecision: '', labels: [], closingIssuesReferences: [], statusCheckRollup: [
    { name: 'check', conclusion: 'FAILURE' }, { context: 'legacy', state: 'ERROR' }, { name: 'passed', conclusion: 'SUCCESS' },
  ] };
  const prompt = workerPrompt({ task, item, repo: 'owner/repo', root: '/repo', base: 'main', pr });
  expect(prompt).toContain('前回の実行は完了条件を満たさず終了');
  expect(prompt).toContain('main を取り込んで競合を解き、CI を通して');
  expect(prompt).toContain('失敗したチェック: check、legacy');
  expect(prompt).not.toContain('check、legacy、passed');
  expect(prompt).toContain('完了条件を満たすか、時間切れまで続けて');
  const first = workerPrompt({ task: { ...task, attempts: 1 }, item, repo: 'owner/repo', root: '/repo', base: 'main' });
  expect(first).not.toContain('前回の実行は完了条件を満たさず終了');
  expect(first).not.toContain('失敗したチェック:');
});
