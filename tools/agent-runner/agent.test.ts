import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentArguments, failedBeforeWork, limitResetAt, usageLimit, workerPrompt } from './agent.ts';

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

it('requires a permission mode for non-interactive Claude', () => {
  expect(() => agentArguments('claude', ['--model', 'example'])).toThrow('--permission-mode');
  expect(agentArguments('claude', ['--permission-mode', 'auto'])).toContain('stream-json');
  expect(agentArguments('claude', ['--permission-mode=acceptEdits'])).toContain('-p');
  expect(agentArguments('claude', ['--dangerously-skip-permissions'])).toContain('-p');
  expect(agentArguments('claude', ['--allowedTools', 'Read,Bash'])).toContain('-p');
});

it('reads quota reset times from Codex and Claude messages', () => {
  const now = new Date(2026, 10, 26, 13, 40).getTime();
  const codex = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 2:21 PM.';
  expect(limitResetAt(codex, now)).toBe(new Date(2026, 10, 26, 14, 21).getTime());
  expect(limitResetAt('try again at 1:05 PM.', now)).toBe(new Date(2026, 10, 27, 13, 5).getTime());
  expect(limitResetAt('try again at 12:30 AM', now)).toBe(new Date(2026, 10, 27, 0, 30).getTime());
  expect(limitResetAt('Claude AI usage limit reached|1795670000', now)).toBe(1795670000_000);
  expect(limitResetAt('You\'ve hit your limit · resets 3pm (Asia/Tokyo)', now)).toBe(new Date(2026, 10, 26, 15, 0).getTime());
  expect(limitResetAt('usage limit reached', now)).toBeUndefined();
});

it('detects quota failures only in CLI failure events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'je2be-agent-'));
  try {
    const log = join(dir, 'run.log');
    const write = (...events: unknown[]) => writeFile(log, events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + '\n');
    await write({ type: 'item.completed', item: { type: 'agent_message', text: 'The usage limit docs say...' } },
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'rate limit reached' } });
    expect(await usageLimit(log)).toBeUndefined();
    await write({ type: 'error', message: 'You’ve hit your usage limit. try again at 2:21 PM.' });
    expect(await usageLimit(log)).toContain('try again at 2:21 PM');
    await write({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1795670000' });
    expect(await usageLimit(log)).toContain('|1795670000');
    expect(await failedBeforeWork(log)).toBe(true);
    await write({ type: 'result', is_error: false, result: 'Done. No usage limit hit.' });
    expect(await usageLimit(log)).toBeUndefined();
    await write('Error: rate limit reached for requests');
    expect(await usageLimit(log)).toContain('rate limit');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
