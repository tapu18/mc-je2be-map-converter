// Self-update: when the runner's own code changed on origin/<base>, fast-forward the
// checkout and exit with RESTART_EXIT_CODE so the supervisor starts the new code.

/** Exit code that asks the supervisor (tools/agent-runner/supervisor.ts) to start the runner again. */
export const RESTART_EXIT_CODE = 75;
/** Set by the supervisor. Without it nobody would restart the runner after it exits. */
export const SUPERVISED_ENV = 'JE2BE_AGENT_RUNNER_SUPERVISED';

interface Launch { startedAt: number; finishedAt?: number; pid?: number }
export interface RunState {
  tasks: { issue: number; launches?: Launch[] }[];
  manager?: { lastStartedAt: number; lastFinishedAt?: number; pid?: number };
}

/** Whether a process group exists. EPERM means it exists but belongs to someone else. */
export function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * CLI runs recorded as started but not finished whose process group still exists.
 * A run without a recorded pid predates pid recording; it is treated as running.
 */
export function runningClis(state: RunState, alive: (pid: number) => boolean = groupAlive): string[] {
  const running: string[] = [];
  const open = (start: number, finish: number | undefined) => finish === undefined || finish < start;
  for (const task of state.tasks) {
    for (const launch of task.launches ?? []) {
      if (!open(launch.startedAt, launch.finishedAt)) continue;
      if (launch.pid === undefined || alive(launch.pid))
        running.push(`#${task.issue} の worker（${new Date(launch.startedAt).toISOString()} 起動${launch.pid === undefined ? '、pid 記録なし' : `、pid ${launch.pid}`}）`);
    }
  }
  const manager = state.manager;
  if (manager && open(manager.lastStartedAt, manager.lastFinishedAt) && (manager.pid === undefined || alive(manager.pid)))
    running.push(`PM（${new Date(manager.lastStartedAt).toISOString()} 起動${manager.pid === undefined ? '、pid 記録なし' : `、pid ${manager.pid}`}）`);
  return running;
}

type Git = (args: string[]) => Promise<string>;
const succeeds = async (git: Git, args: string[]) => git(args).then(() => true, () => false);

/** Reasons the checkout cannot be fast-forwarded safely to origin/<base>. */
export async function checkoutBlockers(git: Git, base: string): Promise<string[]> {
  const reasons: string[] = [];
  const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  if (branch !== base) reasons.push(`checkout が ${base} ではなく ${branch || 'detached HEAD'} にいる`);
  // Untracked files are left to `merge --ff-only`, which refuses to overwrite them.
  if ((await git(['status', '--porcelain', '--untracked-files=no'])).trim()) reasons.push('checkout に未コミットの変更がある');
  if (!await succeeds(git, ['merge-base', '--is-ancestor', 'HEAD', `origin/${base}`])) reasons.push(`checkout の HEAD から origin/${base} へ fast-forward できない`);
  else if (!await succeeds(git, ['diff', '--quiet', 'HEAD', `origin/${base}`, '--', 'package-lock.json']))
    reasons.push('package-lock.json が変わっている（npm install が要る）');
  return reasons;
}

/** Appended to the PM prompt while the new code is not running. */
export function codeWarning(base: string, reasons: string[]): string {
  return `注意（管理プログラムから）: 管理プログラムのコードが origin/${base} で更新されたが、自動の入れ替えを見送った` +
    `（理由: ${reasons.join('、')}）。これは巡回を中止する指示ではない。巡回は通常どおり最後まで続け、` +
    `所有者への報告に「管理プログラムの再起動が必要（理由: ${reasons.join('、')}）」と含めること。`;
}
