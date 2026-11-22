import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { command, CommandError } from './agent-runner/process.ts';
import { agentArguments, AgentLaunchError } from './agent-runner/agent.ts';
import { followProgress } from './agent-runner/progress.ts';
import { managerConfig, managerDue, managerPrompt, managerReport } from './agent-runner/manager.ts';
import type { ManagerConfig, ManagerState } from './agent-runner/manager.ts';
import { activeClaims, canMerge, checksFailed, dependencies, hasLabel } from './agent-runner/policy.ts';
import type { Issue, PullRequest } from './agent-runner/policy.ts';

interface Config {
  repo: string;
  agent: 'codex' | 'claude';
  base: string;
  milestone?: string;
  pollSeconds: number;
  timeoutSeconds: number;
  maxAttempts: number;
  maxRunsPerDay: number;
  autoMerge: boolean;
  agentArgs: string[];
  manager: ManagerConfig;
}
interface Task {
  issue: number;
  branch: string;
  worktree: string;
  claim: string;
  attempts: number;
  phase: 'claiming' | 'working' | 'review' | 'blocked' | 'done';
  error?: string;
}
interface State {
  version: 1;
  repo: string;
  day: string;
  runs: number;
  tasks: Task[];
  manager?: ManagerState;
}

const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'agent-runner.json' },
  once: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('npm run agents -- --config agent-runner.json [--once] [--dry-run]\nLinux/macOS, Node >=24, git, gh and an authenticated codex or claude CLI required.');
  process.exit(0);
}
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

async function main() {
  if (process.platform === 'win32') throw new Error('Use Linux/macOS (or WSL): process-group termination is required.');
  const input: unknown = JSON.parse(await readFile(resolve(values.config!), 'utf8'));
  const config = validateConfig(input);
  const agentArgs = agentArguments(config.agent, config.agentArgs);
  const managerArgs = config.manager.enabled ? agentArguments(config.manager.agent, config.manager.agentArgs) : [];
  const root = (await command('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() })).trim();
  const actualRepo = JSON.parse(await command('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: root, signal: abort.signal })) as { nameWithOwner: string };
  if (actualRepo.nameWithOwner.toLowerCase() !== config.repo.toLowerCase()) throw new Error('Config repo does not match the repository selected by gh in this checkout');
  const common = resolve(root, (await command('git', ['rev-parse', '--git-common-dir'], { cwd: root })).trim());
  const stateDir = join(common, 'agent-runner');
  const gh = (args: string[]) => command('gh', [...args, '--repo', config.repo], { cwd: root, signal: abort.signal });
  const json = async <T>(args: string[]): Promise<T> => JSON.parse(await gh(args)) as T;
  const issue = (number: number) => json<Issue>(['issue', 'view', String(number), '--json', 'number,title,body,state,labels,comments']);
  const prs = (task: Task) => json<PullRequest[]>(['pr', 'list', '--head', task.branch, '--state', 'all', '--json',
    'number,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,reviewDecision,labels,closingIssuesReferences,statusCheckRollup']);
  const ready = () => json<Issue[]>(['issue', 'list', '--state', 'open', '--label', 'status:ready', '--limit', '100',
    ...(config.milestone ? ['--milestone', config.milestone] : []), '--json', 'number,title,body,state,labels,comments']);
  const eligible = async (item: Issue) => {
    if (['needs-approval', 'status:blocked', 'status:paused', 'status:in-progress', 'status:in-review'].some(label => hasLabel(item, label)) || activeClaims(item.comments).length) return false;
    for (const number of dependencies(item.body)) if ((await issue(number)).state !== 'CLOSED') return false;
    return true;
  };

  // Dry-run neither takes the lock nor creates state, claims, worktrees or CLI sessions.
  if (values['dry-run']) {
    log(`dry-run: ${config.repo}, ${config.agent}, base=${config.base}, autoMerge=${config.autoMerge}`);
    log(`PM: ${config.manager.enabled ? `${config.manager.agent}, interval=${config.manager.intervalSeconds}s, idle=${config.manager.runWhenIdle}, daily limit=${config.manager.maxRunsPerDay}` : 'disabled'}`);
    for (const item of (await ready()).sort((a, b) => a.number - b.number)) {
      log(`#${item.number} ${await eligible(item) ? 'eligible' : 'skip'} ${item.title}`);
    }
    return;
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, 'lock');
  // Do not steal stale locks automatically: a crashed manager may have left a worker alive.
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new Error(`Runner lock exists: ${lockPath}. Check for surviving workers before removing it (see docs/agent-runner.md).`);
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    const statePath = join(stateDir, 'state.json');
    let state: State;
    try { state = JSON.parse(await readFile(statePath, 'utf8')) as State; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = { version: 1, repo: config.repo, day: '', runs: 0, tasks: [] };
    }
    if (state.version !== 1 || state.repo !== config.repo || !Array.isArray(state.tasks)) throw new Error('State version/repository mismatch');
    const save = async () => {
      await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    };
    const runManager = async (idle: boolean): Promise<boolean> => {
      if (!managerDue(config.manager, state.manager, Date.now(), idle)) return false;
      const previous = state.manager;
      const day = new Date().toISOString().slice(0, 10);
      const manager: ManagerState = {
        day, runs: (previous?.day === day ? previous.runs : 0) + 1, lastStartedAt: Date.now(),
      };
      state.manager = manager;
      await save(); // Record before spawning: restarting must not repeatedly launch PM.
      const logfile = join(stateDir, `manager-${manager.lastStartedAt}.log`);
      log(`[PM] ${idle ? '着手可能な作業なし' : '定期巡回'}: ${config.manager.agent} 起動（本日 ${manager.runs}/${config.manager.maxRunsPerDay}）、log=${logfile}`);
      const progress = await followProgress(logfile, message => log(`[PM] ${message}`));
      try {
        await command(config.manager.agent, managerArgs, {
          cwd: root, timeoutMs: config.manager.timeoutSeconds * 1000, signal: abort.signal, log: logfile,
          input: managerPrompt(config.repo, config.base, config.milestone, config.manager.instructions, join(stateDir, 'manager-latest.md')),
        });
        const report = await managerReport(logfile);
        const document = `# PM 巡回報告\n\n${new Date().toISOString()} / ${config.manager.agent}\n\n${report}\n`;
        await writeFile(logfile.replace(/\.log$/, '.md'), document, { mode: 0o600 });
        const latest = join(stateDir, 'manager-latest.md');
        await writeFile(`${latest}.tmp`, document, { mode: 0o600 });
        await rename(`${latest}.tmp`, latest);
        log(`[PM] 完了。報告: ${latest}`);
      } catch (error) {
        manager.error = String(error);
        log(`[PM] ${manager.error}`);
        if ((error instanceof CommandError && error.exitCode === 2) ||
            ['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          // Keep worker budgets and the previous PM schedule intact on invalid CLI setup.
          if (previous) state.manager = previous;
          else delete state.manager;
          await save();
          throw new AgentLaunchError(`PM CLI could not start. Fix manager configuration and restart.\n${manager.error}`);
        }
      } finally {
        await progress.close();
        // Do not overwrite the rolled-back state on startup failure.
        if (state.manager === manager) { manager.lastFinishedAt = Date.now(); await save(); }
      }
      return true;
    };
    const status = async (number: number, next: string) => {
      const current = await issue(number);
      const remove = current.labels.map(l => l.name).filter(name => name.startsWith('status:') && name !== next);
      await gh(['issue', 'edit', String(number), '--add-label', next, ...remove.flatMap(name => ['--remove-label', name])]);
    };
    const comment = (number: number, body: string) => gh(['issue', 'comment', String(number), '--body', body]);
    const stopTask = async (task: Task, message: string) => {
      task.phase = 'blocked';
      task.error = message;
      await save();
      await comment(task.issue, `管理プログラムが保留しました: ${message}\nブランチ: ${task.branch}\nworktree: ${task.worktree}\n再開するには原因を解消し、status:ready に戻してください。`);
      await status(task.issue, 'status:blocked');
    };
    const prepare = async (task: Task) => {
      // Idempotent recovery after a crash between worktree creation and state save.
      const trees = (await command('git', ['worktree', 'list', '--porcelain'], { cwd: root })).split('\n\n');
      if (trees.some(tree => tree.includes(`worktree ${task.worktree}\n`) && tree.includes(`branch refs/heads/${task.branch}`))) return;
      await command('git', ['fetch', 'origin', config.base], { cwd: root, signal: abort.signal });
      await command('git', ['worktree', 'add', '-b', task.branch, task.worktree, `origin/${config.base}`], { cwd: root, signal: abort.signal });
    };
    const run = async (task: Task, item: Issue) => {
      if (task.attempts >= config.maxAttempts) { await stopTask(task, `実行回数の上限 ${config.maxAttempts} 回に到達`); return; }
      if (state.runs >= config.maxRunsPerDay) { log('Daily run limit reached; waiting.'); return; }
      await prepare(task);
      task.attempts++;
      state.runs++;
      task.phase = 'working';
      await save();
      const logfile = join(stateDir, `${task.issue}-${Date.now()}.log`);
      const prompt = [
        `あなたは ${task.claim}。${config.repo} の Issue #${task.issue} だけを作業してください。`,
        `既存の worktree ${task.worktree} とブランチ ${task.branch} を使ってください。着手済みです。`,
        '最初に CLAUDE.md と docs/workflow.md と Issue の本文・コメント、既存PRとCIを読んでください。',
        '再実行の場合があります。git status と履歴を確認し、未コミット変更や既存PRを引き継いでください。',
        '依存の未完了や人の判断が必要なら、Issue に根拠を書き status:blocked または needs-approval にして終了してください。',
        'npm ci、必要な setup:servers / setup:mappings、build:pack を行い、実装・適切な検証・コミット・push・PR作成まで進めてください。',
        `配布マップの原本は ${join(root, 'sample-map')}（git管理外）にあります。必要なら読み取り用に参照し、原本を変更・GitHubへ公開しないでください。`,
        'PR本文に Closes #' + task.issue + ' を記載。既存PRがあれば修正してください。完了条件を検証できるまでdraftにしてください。',
        'npm run check と関連する実サーバーテストを通し、完了条件を満たしたらPRをreadyにしてください。CI失敗時は原因を調べて修正してください。',
        'マージとブランチ/worktree削除は管理プログラムが判断するので実行しないでください。Issueのclaimは変更しないでください。',
        '別のIssueには着手しないでください。新たな作業はIssueに記録してください。区切りごとに進捗と再開手順をIssueへ残してください。',
        '管理プログラムの設定・状態・ロックは変更しないでください。',
        `今回のIssueスナップショット（最新状態はghで確認）:\n${JSON.stringify(item)}`,
      ].join('\n');
      log(`Running ${config.agent} for #${task.issue}, attempt ${task.attempts}; log=${logfile}`);
      const progress = await followProgress(logfile, message => log(`#${task.issue} ${message}`));
      try {
        await command(config.agent, agentArgs,
        { cwd: task.worktree, timeoutMs: config.timeoutSeconds * 1000, signal: abort.signal, log: logfile, input: prompt });
        delete task.error;
      } catch (error) {
        task.error = String(error);
        log(task.error);
        if ((error instanceof CommandError && error.exitCode === 2) ||
            ['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          // Invalid invocation / missing executable is infrastructure failure, not work.
          task.attempts--;
          state.runs--;
          await save();
          throw new AgentLaunchError(`AI CLI could not start. Fix the configuration and restart.\n${task.error}`);
        }
      } finally { await progress.close(); }
      // CLI exit is not evidence of completion. Reconcile with GitHub next tick.
      await save();
    };

    const tick = async () => {
      const day = new Date().toISOString().slice(0, 10);
      if (day !== state.day) { state.day = day; state.runs = 0; await save(); }
      if (await runManager(false)) return;
      for (const task of state.tasks) {
        if (task.phase === 'done') continue;
        const item = await issue(task.issue);
        if (item.state === 'CLOSED') { log(`#${task.issue} 完了（Issue はクローズ済み）`); task.phase = 'done'; await save(); continue; }
        if (task.phase !== 'claiming' && activeClaims(item.comments)[0] !== task.claim) {
          log(`#${task.issue}: claim no longer owned; leaving the task untouched.`);
          task.phase = 'done';
          await save();
          continue;
        }
        if (task.phase === 'blocked') {
          if (!hasLabel(item, 'status:ready') || hasLabel(item, 'needs-approval')) { log(`#${task.issue} 保留中（再開指示待ち）`); continue; }
          task.attempts = 0;
          task.phase = 'working';
          await status(task.issue, 'status:in-progress');
          await save();
        }
        if (['needs-approval', 'status:blocked', 'status:paused'].some(label => hasLabel(item, label))) { log(`#${task.issue} 承認・保留解除待ち`); continue; }
        if (task.phase === 'claiming') {
          const claims = activeClaims(item.comments);
          if (claims[0] !== task.claim) {
            // On uncertain/crashed claim publication, never publish a second claim.
            await comment(task.issue, `claim-cancelled: ${task.claim}\n着手権を確認できないため停止しました。`);
            task.phase = 'done';
            await save();
            continue;
          }
          await status(task.issue, 'status:in-progress');
          task.phase = 'working';
          await save();
        }
        const pulls = await prs(task);
        if (pulls.some(pr => pr.state === 'MERGED')) {
          // Closes may be absent/malformed; don't silently leave the issue ready.
          await stopTask(task, 'PRはマージ済みですがIssueが開いています。完了条件と関連付けを確認してください。');
          continue;
        }
        const pr = pulls.find(pr => pr.state === 'OPEN');
        if (pr) {
          if (hasLabel(pr, 'needs-approval')) { log(`#${task.issue} PR #${pr.number} 承認待ち`); continue; }
          if (config.autoMerge && canMerge(item, pr, config.base)) {
            // Recheck immediately; gh's SHA guard rejects head updates during merge.
            const freshIssue = await issue(task.issue);
            const fresh = (await prs(task)).find(p => p.number === pr.number);
            if (fresh && canMerge(freshIssue, fresh, config.base)) {
              await gh(['pr', 'merge', String(pr.number), '--merge', '--match-head-commit', fresh.headRefOid]);
              log(`Merged #${pr.number} for issue #${task.issue}`);
            }
            continue;
          }
          if (!pr.isDraft && !checksFailed(pr) && pr.mergeStateStatus !== 'DIRTY' && pr.reviewDecision !== 'CHANGES_REQUESTED') {
            const passed = pr.statusCheckRollup.filter(check => (check.conclusion ?? check.state) === 'SUCCESS').length;
            log(`#${task.issue} PR #${pr.number} CI・マージ待ち（チェック成功 ${passed}/${pr.statusCheckRollup.length}、状態 ${pr.mergeStateStatus}、自動マージ ${config.autoMerge ? '有効' : '無効'}）`);
            if (task.phase !== 'review') { await status(task.issue, 'status:in-review'); task.phase = 'review'; await save(); }
            continue;
          }
        } else if (pulls.length) {
          await stopTask(task, 'PRがマージされずに閉じられました');
          continue;
        }
        await run(task, item);
        return; // At most one worker per tick.
      }
      // PM has its own budget; it may run even when worker runs are exhausted.
      if (state.runs >= config.maxRunsPerDay) { log(`日次起動上限 ${state.runs}/${config.maxRunsPerDay}。UTC の日付更新待ち`); return; }
      for (const candidate of (await ready()).sort((a, b) => a.number - b.number)) {
        if (state.tasks.some(task => task.issue === candidate.number) || !await eligible(candidate)) continue;
        const id = randomUUID();
        const task: Task = { issue: candidate.number, branch: `${candidate.number}-agent-${id.slice(0, 8)}`,
          worktree: join(stateDir, 'worktrees', String(candidate.number)), claim: `${config.agent}-${id}`, attempts: 0, phase: 'claiming' };
        state.tasks.push(task);
        await save(); // Persist before any remote mutation for crash recovery.
        await comment(task.issue, `claim: ${task.claim} (branch ${task.branch})`);
        log(`#${task.issue} 着手を予約しました。次の巡回で着手権を確認します`);
        // Reconcile claim ordering next tick before starting any implementation.
        return;
      }
      if (await runManager(true)) return;
      log('巡回完了。着手可能な作業がなければ待機します。');
    };

    log(`Started ${config.repo}: ${config.agent}, state=${statePath}`);
    do {
      log(`巡回開始（本日の AI 起動 ${state.runs}/${config.maxRunsPerDay}）`);
      try { await tick(); }
      catch (error) { if (!abort.signal.aborted) log(`巡回失敗（状態を維持）: ${String(error)}`); if (values.once || error instanceof AgentLaunchError) throw error; }
      if (values.once || abort.signal.aborted) break;
      log(`次の巡回まで ${config.pollSeconds}秒待機`);
      await delay(config.pollSeconds * 1000, undefined, { signal: abort.signal }).catch(() => {});
    } while (!abort.signal.aborted);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

function validateConfig(input: unknown): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object');
  const raw = input as Record<string, unknown>;
  const defaults = { agent: 'codex', base: 'main', pollSeconds: 60, timeoutSeconds: 3600, maxAttempts: 3, maxRunsPerDay: 12, autoMerge: true, agentArgs: [] };
  const config = { ...defaults, ...raw } as unknown as Config;
  for (const key of Object.keys(raw)) if (![...Object.keys(defaults), 'repo', 'milestone', 'manager'].includes(key)) throw new Error(`Unknown config key: ${key}`);
  config.manager = managerConfig(raw.manager);
  if (typeof config.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(config.repo)) throw new Error('repo must be owner/repository');
  if (!['codex', 'claude'].includes(config.agent)) throw new Error('agent must be codex or claude');
  if (typeof config.base !== 'string' || !/^[\w][\w./-]*$/.test(config.base)) throw new Error('Invalid base branch');
  if (config.milestone !== undefined && (typeof config.milestone !== 'string' || !config.milestone)) throw new Error('Invalid milestone');
  for (const key of ['pollSeconds', 'timeoutSeconds', 'maxAttempts', 'maxRunsPerDay'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (typeof config.autoMerge !== 'boolean' || !Array.isArray(config.agentArgs) || !config.agentArgs.every(arg => typeof arg === 'string')) throw new Error('Invalid autoMerge or agentArgs');
  return config;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
