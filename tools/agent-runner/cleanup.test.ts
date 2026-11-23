import { expect, it } from 'vitest';
import { cleanupMerged } from './cleanup.ts';

const task = { issue: 7, branch: '7-agent-abcdef12', worktree: '/repo/.git/agent-runner/worktrees/7' };
function fixture(options: { dirty?: boolean; children?: boolean; remote?: string; head?: string; otherTree?: boolean } = {}) {
  const calls: string[][] = [];
  const run = async (program: string, args: string[]) => {
    calls.push([program, ...args]);
    if (program === 'gh' && args.includes('--head')) return JSON.stringify([{ state: 'MERGED', headRefName: task.branch, headRefOid: 'abc', baseRefName: 'main', closingIssuesReferences: [{ number: 7 }] }]);
    if (program === 'gh') return JSON.stringify(options.children ? [{ number: 8 }] : []);
    if (args[0] === 'worktree' && args[1] === 'list') return options.otherTree ? `worktree /other\nbranch refs/heads/${task.branch}\n\n` : `worktree ${task.worktree}\nbranch refs/heads/${task.branch}\n\n`;
    if (args[0] === 'status') return options.dirty ? '!! valuable-file\n' : '';
    if (args[0] === 'rev-parse') return options.head ?? 'abc';
    if (args[0] === 'ls-remote') return `${options.remote ?? 'abc'}\trefs/heads/${task.branch}\n`;
    return '';
  };
  return { calls, run };
}
const clean = (f: ReturnType<typeof fixture>) => cleanupMerged(task, '/repo', '/repo/.git/agent-runner', 'owner/repo', 'main', f.run);
it('removes a clean merged worktree and branches with a remote lease', async () => {
  const f = fixture(); expect(await clean(f)).toBe(true);
  expect(f.calls).toContainEqual(['git', 'worktree', 'remove', task.worktree]);
  expect(f.calls).toContainEqual(['git', 'push', 'origin', `--force-with-lease=refs/heads/${task.branch}:abc`, `:refs/heads/${task.branch}`]);
});
it.each([{ dirty: true }, { children: true }, { head: 'new' }, { otherTree: true }])('preserves worktree when unsafe: %o', async options => {
  const f = fixture(options); expect(await clean(f)).toBe(false);
  expect(f.calls.some(call => call[1] === 'worktree' && call[2] === 'remove')).toBe(false);
});
it('does not delete a remote branch advanced after merging', async () => {
  const f = fixture({ remote: 'new' }); expect(await clean(f)).toBe(false);
  expect(f.calls.some(call => call[1] === 'push')).toBe(false);
});
