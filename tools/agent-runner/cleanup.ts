import { resolve, join } from 'node:path';
import { command } from './process.ts';

interface Task { issue: number; branch: string; worktree: string }
interface PR { state: string; headRefName: string; headRefOid: string; baseRefName: string; closingIssuesReferences: { number: number }[] }
type Run = (program: string, args: string[], options: { cwd: string }) => Promise<string>;

// Only these ignored paths are disposable build/setup output; sample-map and other
// ignored files may contain user data. Git reports ignored directories collapsed.
function generated(path: string): boolean {
  return /(^|\/)(node_modules|servers|dist)\/$/.test(path) ||
    path.endsWith('.tsbuildinfo') || path === 'packages/bridge-pack/pack/scripts/' ||
    /^poc\/[^/]+\/pack\/(scripts|structures)\/$/.test(path);
}

// Refuse ambiguous or dirty worktrees; every destructive step is independently retryable.
export async function cleanupMerged(task: Task, root: string, stateDir: string, repo: string, base: string, run: Run = command, report: (reason: string) => void = () => {}): Promise<boolean> {
  const refuse = (reason: string) => { report(reason); return false; };
  const git = (args: string[], cwd = root) => run('git', args, { cwd });
  const gh = (args: string[]) => run('gh', [...args, '--repo', repo], { cwd: root });
  if (resolve(task.worktree) !== join(stateDir, 'worktrees', String(task.issue)) || !new RegExp(`^${task.issue}-agent-[a-f0-9]{8}$`).test(task.branch)) return refuse('worktree path or branch is invalid');
  const prs = JSON.parse(await gh(['pr', 'list', '--head', task.branch, '--state', 'all', '--limit', '100', '--json', 'state,headRefName,headRefOid,baseRefName,closingIssuesReferences'])) as PR[];
  const merged = prs.find(pr => pr.state === 'MERGED' && pr.headRefName === task.branch && pr.baseRefName === base && pr.closingIssuesReferences.some(ref => ref.number === task.issue));
  if (!merged || prs.some(pr => pr.state === 'OPEN')) return refuse('matching merged PR missing or an open PR exists');
  const children = JSON.parse(await gh(['pr', 'list', '--base', task.branch, '--state', 'open', '--limit', '100', '--json', 'number'])) as unknown[];
  if (children.length) return refuse('open dependent PR exists');
  await git(['fetch', 'origin', base]);
  try { await git(['merge-base', '--is-ancestor', merged.headRefOid, `origin/${base}`]); } catch { return refuse('merged commit is not an ancestor of the base'); }
  const trees = await git(['worktree', 'list', '--porcelain']);
  const entries = trees.split('\n\n');
  const tree = entries.find(entry => entry.split('\n').includes(`worktree ${task.worktree}`));
  if (entries.some(entry => entry !== tree && entry.split('\n').includes(`branch refs/heads/${task.branch}`))) return refuse('branch is checked out in another worktree');
  let local: string | undefined;
  try { local = (await git(['rev-parse', '--verify', `refs/heads/${task.branch}`])).trim(); } catch { /* already removed */ }
  if (local && local !== merged.headRefOid) return refuse('local branch has moved');
  const remote = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${task.branch}`])).trim().split(/\s+/)[0];
  if (remote && remote !== merged.headRefOid) return refuse('remote branch has moved');
  if (tree) {
    if (!tree.split('\n').includes(`branch refs/heads/${task.branch}`) || /\nlocked(?: |\n)/.test(tree)) return refuse('worktree is locked or has a different branch');
    const status = await git(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal'], task.worktree);
    for (const entry of status.split('\0').filter(Boolean)) {
      if (!entry.startsWith('!! ') || !generated(entry.slice(3))) return refuse(`worktree contains changes or non-generated files: ${JSON.stringify(entry)}`);
    }
    if ((await git(['rev-parse', 'HEAD'], task.worktree)).trim() !== merged.headRefOid) return refuse('worktree HEAD has moved');
    await git(['worktree', 'remove', task.worktree]);
  }
  if (local) await git(['update-ref', '-d', `refs/heads/${task.branch}`, merged.headRefOid]);
  if (remote) await git(['push', 'origin', `--force-with-lease=refs/heads/${task.branch}:${merged.headRefOid}`, `:refs/heads/${task.branch}`]);
  return true;
}
