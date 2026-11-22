import { resolve, join } from 'node:path';
import { command } from './process.ts';

interface Task { issue: number; branch: string; worktree: string }
interface PR { state: string; headRefName: string; headRefOid: string; baseRefName: string; closingIssuesReferences: { number: number }[] }
type Run = (program: string, args: string[], options: { cwd: string }) => Promise<string>;

// Refuse ambiguous or dirty worktrees; every destructive step is independently retryable.
export async function cleanupMerged(task: Task, root: string, stateDir: string, repo: string, base: string, run: Run = command): Promise<boolean> {
  const git = (args: string[], cwd = root) => run('git', args, { cwd });
  const gh = (args: string[]) => run('gh', [...args, '--repo', repo], { cwd: root });
  if (resolve(task.worktree) !== join(stateDir, 'worktrees', String(task.issue)) || !new RegExp(`^${task.issue}-agent-[a-f0-9]{8}$`).test(task.branch)) return false;
  const prs = JSON.parse(await gh(['pr', 'list', '--head', task.branch, '--state', 'all', '--limit', '100', '--json', 'state,headRefName,headRefOid,baseRefName,closingIssuesReferences'])) as PR[];
  const merged = prs.find(pr => pr.state === 'MERGED' && pr.headRefName === task.branch && pr.baseRefName === base && pr.closingIssuesReferences.some(ref => ref.number === task.issue));
  if (!merged || prs.some(pr => pr.state === 'OPEN')) return false;
  const children = JSON.parse(await gh(['pr', 'list', '--base', task.branch, '--state', 'open', '--limit', '100', '--json', 'number'])) as unknown[];
  if (children.length) return false;
  await git(['fetch', 'origin', base]);
  try { await git(['merge-base', '--is-ancestor', merged.headRefOid, `origin/${base}`]); } catch { return false; }
  const trees = await git(['worktree', 'list', '--porcelain']);
  const entries = trees.split('\n\n');
  const tree = entries.find(entry => entry.split('\n').includes(`worktree ${task.worktree}`));
  if (entries.some(entry => entry !== tree && entry.split('\n').includes(`branch refs/heads/${task.branch}`))) return false;
  let local: string | undefined;
  try { local = (await git(['rev-parse', '--verify', `refs/heads/${task.branch}`])).trim(); } catch { /* already removed */ }
  if (local && local !== merged.headRefOid) return false;
  const remote = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${task.branch}`])).trim().split(/\s+/)[0];
  if (remote && remote !== merged.headRefOid) return false;
  if (tree) {
    if (!tree.split('\n').includes(`branch refs/heads/${task.branch}`) || /\nlocked(?: |\n)/.test(tree)) return false;
    if ((await git(['status', '--porcelain', '--ignored'], task.worktree)).trim()) return false;
    if ((await git(['rev-parse', 'HEAD'], task.worktree)).trim() !== merged.headRefOid) return false;
    await git(['worktree', 'remove', task.worktree]);
  }
  if (local) await git(['update-ref', '-d', `refs/heads/${task.branch}`, merged.headRefOid]);
  if (remote) await git(['push', 'origin', `--force-with-lease=refs/heads/${task.branch}:${merged.headRefOid}`, `:refs/heads/${task.branch}`]);
  return true;
}
