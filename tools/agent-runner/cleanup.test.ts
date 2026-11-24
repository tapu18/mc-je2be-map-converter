import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from './process.ts';
import { cleanupMerged } from './cleanup.ts';

const task = { issue: 7, branch: '7-agent-abcdef12', worktree: '/repo/.git/agent-runner/worktrees/7' };
function fixture(options: { dirty?: boolean; children?: boolean; remote?: string; head?: string; otherTree?: boolean } = {}) {
  const calls: string[][] = [];
  const run = async (program: string, args: string[]) => {
    calls.push([program, ...args]);
    if (program === 'gh' && args.includes('--head')) return JSON.stringify([{ state: 'MERGED', headRefName: task.branch, headRefOid: 'abc', baseRefName: 'main', closingIssuesReferences: [{ number: 7 }] }]);
    if (program === 'gh') return JSON.stringify(options.children ? [{ number: 8 }] : []);
    if (args[0] === 'worktree' && args[1] === 'list') return options.otherTree ? `worktree /other\nbranch refs/heads/${task.branch}\n\n` : `worktree ${task.worktree}\nbranch refs/heads/${task.branch}\n\n`;
    if (args[0] === 'status') return options.dirty ? '?? valuable-file\0' : '';
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


it.each([
  { name: 'generated output', path: 'node_modules/package/file', removed: true },
  { name: 'Python bytecode cache', path: 'scripts/__pycache__/dump.cpython-312.pyc', removed: true },
  { name: 'nested Python bytecode cache', path: 'tools/lib/__pycache__/x.cpython-312.pyc', removed: true },
  { name: 'runtime host pack output', path: 'packages/runtime-host/pack/scripts/main.js', removed: true },
  { name: 'untracked file beside the runtime host pack output', path: 'packages/runtime-host/pack/manifest.json', removed: false },
  { name: 'untracked source', path: 'new-source.ts', removed: false },
  { name: 'ignored user data', path: 'sample-map/world', removed: false },
])('handles $name in a real worktree', async ({ path, removed }) => {
  const dir = await mkdtemp(join(tmpdir(), 'cleanup-test-'));
  const root = join(dir, 'repo');
  const stateDir = join(root, '.git', 'agent-runner');
  const worktree = join(stateDir, 'worktrees', '7');
  const git = (args: string[]) => command('git', args, { cwd: root });
  try {
    await mkdir(root);
    await git(['init', '-q']);
    await writeFile(join(root, '.gitignore'), 'node_modules/\nsample-map/\n__pycache__/\npackages/runtime-host/pack/scripts/\n');
    // Tracked siblings, as in the real repository, keep git from collapsing ignored output to its parent.
    for (const file of ['scripts/dump.py', 'tools/lib/x.py', 'packages/runtime-host/package.json']) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), '');
    }
    await git(['add', '.']);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    await git(['worktree', 'add', '-qb', task.branch, worktree]);
    await mkdir(join(worktree, path, '..'), { recursive: true });
    await writeFile(join(worktree, path), 'data');
    const run = async (program: string, args: string[], options: { cwd: string }) => {
      if (program === 'gh') return JSON.stringify(args.includes('--head') ? [{ state: 'MERGED', headRefName: task.branch, headRefOid: head, baseRefName: 'main', closingIssuesReferences: [{ number: 7 }] }] : []);
      if (args[0] === 'fetch' || args[0] === 'merge-base' || args[0] === 'ls-remote') return '';
      return command(program, args, options);
    };
    const reasons: string[] = [];
    expect(await cleanupMerged({ ...task, worktree }, root, stateDir, 'owner/repo', 'main', run, reason => reasons.push(reason))).toBe(removed);
    expect(await access(worktree).then(() => true, () => false)).toBe(!removed);
    if (!removed) expect(reasons[0]).toContain('worktree contains changes or non-generated files');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
