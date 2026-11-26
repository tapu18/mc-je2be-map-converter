import { cleanupMerged } from './agent-runner/cleanup.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { command, CommandError } from './agent-runner/process.ts';
import { agentArguments, AgentLaunchError, failedBeforeWork, limitResetAt, usageLimit, validateWorkerArgs, workerPrompt } from './agent-runner/agent.ts';
import { followProgress } from './agent-runner/progress.ts';
import { managerConfig, managerDue, managerPrompt, managerReport } from './agent-runner/manager.ts';
import type { ManagerConfig, ManagerState } from './agent-runner/manager.ts';
import { activeClaims, baseAllowsMerge, canMerge, checksFailed, dependencies, hasLabel, latestBaseRun } from './agent-runner/policy.ts';
import type { Issue, PullRequest, WorkflowRun } from './agent-runner/policy.ts';

type Agent = 'codex' | 'claude';
interface Config {
  repo: string;
  agent: Agent;
  base: string;
  milestone?: string;
  pollSeconds: number;
  timeoutSeconds: number;
  maxAttempts: number;
  maxTotalAttempts: number;
  maxRunsPerDay: number;
  limitWaitSeconds: number;
  autoMerge: boolean;
  agentArgs: string[];
  manager: ManagerConfig;
  workerOverrides: Record<string, { agent?: Agent; agentArgs?: string[] }>;
}
interface Task {
  issue: number;
  branch: string;
  worktree: string;
  claim: string;
  attempts: number;
  totalAttempts?: number;
  phase: 'claiming' | 'working' | 'review' | 'blocked' | 'done';
  error?: string;
  launches?: { agent: string; args: string[]; startedAt: number; finishedAt?: number; counted: boolean; limited?: boolean }[];
}
interface State {
  version: 1;
  repo: string;
  day: string;
  runs: number;
  tasks: Task[];
  manager?: ManagerState;
  /** Provider quota per CLI: launches of that CLI wait until the reset time. */
  limits?: Partial<Record<Agent, { until: number; message: string }>>;
  codeWarning?: string;
  startupCode?: string[];
}

const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'agent-runner.json' },
  once: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
  report: { type: 'boolean', default: false },
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
  validateWorkerArgs(config.agentArgs);
  agentArguments(config.agent, config.agentArgs);
  for (const override of Object.values(config.workerOverrides)) {
    const args = override.agentArgs ?? config.agentArgs;
    validateWorkerArgs(args);
    agentArguments(override.agent ?? config.agent, args);
  }
  if (config.manager.enabled) validateWorkerArgs(config.manager.agentArgs);
  const managerArgs = config.manager.enabled ? agentArguments(config.manager.agent, config.manager.agentArgs) : [];
  const workerFor = (item: Issue) => {
    const matching = Object.entries(config.workerOverrides).filter(([label]) => hasLabel(item, label));
    if (matching.length > 1) throw new AgentLaunchError(`Multiple worker overrides match issue #${item.number}: ${matching.map(([label]) => label).join(', ')}`);
    const override = matching[0]?.[1];
    const agent = override?.agent ?? config.agent;
    return { agent, args: agentArguments(agent, override?.agentArgs ?? config.agentArgs) };
  };
  const root = (await command('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() })).trim();
  const codeAt = async (ref: string) => (await command('git', ['rev-parse', `${ref}:tools/agent-runner.ts`, `${ref}:tools/agent-runner`], { cwd: root, signal: abort.signal })).trim().split('\n');
  const startupCode = await codeAt('HEAD');
  const actualRepo = JSON.parse(await command('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: root, signal: abort.signal })) as { nameWithOwner: string };
  if (actualRepo.nameWithOwner.toLowerCase() !== config.repo.toLowerCase()) throw new Error('Config repo does not match the repository selected by gh in this checkout');
  const common = resolve(root, (await command('git', ['rev-parse', '--git-common-dir'], { cwd: root })).trim());
  const stateDir = join(common, 'agent-runner');
  const gh = (args: string[]) => command('gh', [...args, '--repo', config.repo], { cwd: root, signal: abort.signal });
  const json = async <T>(args: string[]): Promise<T> => JSON.parse(await gh(args)) as T;
  const issue = (number: number) => json<Issue>(['issue', 'view', String(number), '--json', 'number,title,body,state,labels,comments']);
  const prs = (task: Task) => json<PullRequest[]>(['pr', 'list', '--head', task.branch, '--state', 'all', '--json',
    'number,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,reviewDecision,labels,closingIssuesReferences,statusCheckRollup']);
  const ciRuns = (pr: PullRequest) => json<WorkflowRun[]>(['run', 'list', '--workflow', 'ci.yml', '--branch', pr.headRefName, '--limit', '100', '--json', 'headSha,event,status,conclusion']);
  const baseRuns = () => json<WorkflowRun[]>(['run', 'list', '--workflow', 'ci.yml', '--branch', config.base, '--event', 'push', '--limit', '100', '--json', 'headSha,event,status,conclusion']);
  const git = (args: string[]) => command('git', args, { cwd: root, signal: abort.signal });
  const api = async <T>(path: string): Promise<T> => JSON.parse(await command('gh', ['api', path], { cwd: root, signal: abort.signal })) as T;
  const reportBaseFailure = async (run: WorkflowRun) => {
    const marker = `<!-- agent-runner-base-ci:${run.headSha} -->`;
    const associated = await api<{ number: number }[]>(`repos/${config.repo}/commits/${run.headSha}/pulls`);
    for (const pull of associated) {
      const details = await json<{ closingIssuesReferences: { number: number }[] }>(['pr', 'view', String(pull.number), '--json', 'closingIssuesReferences']);
      for (const ref of details.closingIssuesReferences) {
        const target = await issue(ref.number);
        if (!target.comments.some(c => c.body.includes(marker)))
          await gh(['issue', 'comment', String(ref.number), '--body', `${marker}\n${config.base} の push CI が ${run.conclusion} です（commit ${run.headSha}、PR #${pull.number}）。自動マージを停止します。Actions の CI を調査してください。`]);
        return;
      }
    }
    const existing = await json<{ number: number }[]>(['issue', 'list', '--state', 'all', '--search', `agent-runner base CI ${run.headSha} in:title`, '--json', 'number']);
    if (!existing.length) await gh(['issue', 'create', '--title', `agent-runner base CI ${run.headSha}`, '--body', `${marker}\n${config.base} の push CI が ${run.conclusion} です。自動マージを停止しています。Actions の CI を調査してください。`]);
  };
  const baseSafety = async (pr: PullRequest): Promise<boolean> => {
    const runs = await baseRuns();
    const latest = latestBaseRun(runs);
    if (latest && latest.conclusion !== 'success') {
      log(`${config.base} push CI ${latest.headSha}: ${latest.conclusion}。自動マージ停止`);
      await reportBaseFailure(latest);
      return false;
    }
    if (!latest) { log(`${config.base} の完了した push CI がないため自動マージ停止`); return false; }
    await git(['fetch', '--no-tags', 'origin', config.base, pr.headRefName]);
    const baseSha = (await git(['rev-parse', `origin/${config.base}`])).trim();
    const headSha = (await git(['rev-parse', `origin/${pr.headRefName}`])).trim();
    if (headSha !== pr.headRefOid) return false;
    const ancestor = (await git(['merge-base', baseSha, headSha])).trim();
    const paths = async (from: string, to: string) => (await git(['diff', '--no-renames', '--name-only', '-z', from, to])).split('\0').filter(Boolean);
    const baseChanges = await paths(ancestor, baseSha);
    const prChanges = await paths(ancestor, headSha);
    if (!baseAllowsMerge(runs, baseChanges, prChanges)) {
      log(`PR #${pr.number}: base と同じファイルを変更。ブランチを更新して CI を待ちます`);
      await gh(['pr', 'update-branch', String(pr.number)]);
      return false;
    }
    // Refuse a merge if the base moved while calculating the intersection.
    const remote = (await git(['ls-remote', 'origin', `refs/heads/${config.base}`])).split(/\s/)[0];
    return remote === baseSha;
  };
  const ready = () => json<Issue[]>(['issue', 'list', '--state', 'open', '--label', 'status:ready', '--limit', '100',
    ...(config.milestone ? ['--milestone', config.milestone] : []), '--json', 'number,title,body,state,labels,comments']);
  const eligible = async (item: Issue) => {
    if (['needs-approval', 'status:blocked', 'status:paused', 'status:in-progress', 'status:in-review'].some(label => hasLabel(item, label)) || activeClaims(item.comments).length) return false;
    for (const number of dependencies(item.body)) if ((await issue(number)).state !== 'CLOSED') return false;
    return true;
  };

  if (values.report) {
    const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')) as State;
    if (state.version !== 1 || state.repo !== config.repo || !Array.isArray(state.tasks)) throw new Error('State version/repository mismatch');
    for (const task of state.tasks) {
      const pulls = await prs(task);
      const launches = task.launches ?? [];
      console.log(JSON.stringify({ issue: task.issue, launches: launches.length, legacyAttempts: task.launches ? undefined : task.attempts, merged: pulls.some(pr => pr.state === 'MERGED'), runs: launches.map(run => ({ ...run, durationMs: run.finishedAt === undefined ? null : run.finishedAt - run.startedAt })) }));
    }
    for (const [agent, limit] of Object.entries(state.limits ?? {})) {
      console.log(JSON.stringify({ limit: agent, until: new Date(limit.until).toISOString(), active: limit.until > Date.now(), message: limit.message }));
    }
    return;
  }

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
    state.startupCode = startupCode;
    delete state.codeWarning;
    const save = async () => {
      await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    };
    const limited = (agent: Agent) => {
      const limit = state.limits?.[agent];
      return limit && limit.until > Date.now() ? limit : undefined;
    };
    // A quota is an account condition, not a broken setup or the task's fault: record it,
    // refund the launch and keep the runner alive for other CLIs and later ticks.
    const recordLimit = async (agent: Agent, logfile: string, error: unknown) => {
      if (!(error instanceof CommandError) || error.exitCode === null) return false;
      const message = await usageLimit(logfile);
      if (!message) return false;
      const now = Date.now();
      const reset = limitResetAt(message, now);
      // One minute of slack: reset clocks are minute-rounded.
      const until = reset !== undefined && reset > now ? reset + 60_000 : now + config.limitWaitSeconds * 1000;
      (state.limits ??= {})[agent] = { until, message: message.slice(0, 500) };
      await save();
      log(`${agent} の使用量の上限: ${new Date(until).toISOString()} まで ${agent} の起動を見送ります`);
      return true;
    };
    const runManager = async (idle: boolean): Promise<boolean> => {
      if (!managerDue(config.manager, state.manager, Date.now(), idle)) return false;
      if (limited(config.manager.agent)) { log(`[PM] ${config.manager.agent} は使用量の上限で見送り中`); return false; }
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
          input: managerPrompt(config.repo, config.base, config.milestone, config.manager.instructions, join(stateDir, 'manager-latest.md')) + (state.codeWarning ? `\n\n${state.codeWarning}` : ''),
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
        if (await recordLimit(config.manager.agent, logfile, error)) {
          // Not a PM run: keep the previous schedule so PM runs once the quota resets.
          if (previous) state.manager = previous;
          else delete state.manager;
          await save();
          return false;
        }
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
    /** Returns 'limited' when the selected CLI is waiting for its quota, so other tasks may run. */
    const run = async (task: Task, item: Issue, pr?: PullRequest): Promise<'limited' | undefined> => {
      const { agent, args } = workerFor(item);
      if (limited(agent)) { log(`#${task.issue} ${agent} は使用量の上限で見送り中（${new Date(limited(agent)!.until).toISOString()} まで）`); return 'limited'; }
      if (task.attempts >= config.maxAttempts) { await stopTask(task, `実行回数の上限 ${config.maxAttempts} 回に到達`); return; }
      if ((task.totalAttempts ?? task.attempts) >= config.maxTotalAttempts) { await stopTask(task, `合計実行回数の上限 ${config.maxTotalAttempts} 回に到達`); return; }
      if (state.runs >= config.maxRunsPerDay) { log('Daily run limit reached; waiting.'); return; }
      await prepare(task);
      const remoteHead = async () => (await git(['ls-remote', '--heads', 'origin', `refs/heads/${task.branch}`])).trim().split(/\s+/)[0] || undefined;
      let before: string | undefined;
      try { before = await remoteHead() ?? (await git(['rev-parse', `origin/${config.base}`])).trim(); }
      catch (error) { log(`Could not record remote head: ${String(error)}`); }
      const launch: NonNullable<Task['launches']>[number] = { agent, args, startedAt: Date.now(), counted: true };
      (task.launches ??= []).push(launch);
      task.totalAttempts = (task.totalAttempts ?? task.attempts) + 1;
      task.attempts++;
      state.runs++;
      task.phase = 'working';
      await save();
      const logfile = join(stateDir, `${task.issue}-${launch.startedAt}.log`);
      const prompt = workerPrompt({ task, item, repo: config.repo, root, base: config.base, pr });
      await writeFile(logfile, `agent-runner launch: ${JSON.stringify(launch)}\n`, { mode: 0o600 });
      log(`Running ${agent} ${JSON.stringify(args)} for #${task.issue}, attempt ${task.attempts}; log=${logfile}`);
      const progress = await followProgress(logfile, message => log(`#${task.issue} ${message}`));
      let quota = false;
      try {
        await command(agent, args,
        { cwd: task.worktree, timeoutMs: config.timeoutSeconds * 1000, signal: abort.signal, log: logfile, input: prompt });
        delete task.error;
      } catch (error) {
        task.error = String(error);
        log(task.error);
        if (await recordLimit(agent, logfile, error)) {
          quota = true;
          task.attempts--;
          task.totalAttempts!--;
          state.runs--;
          launch.counted = false;
          launch.limited = true;
        } else if ((error instanceof CommandError && (error.exitCode === 2 ||
              (error.exitCode !== null && await failedBeforeWork(logfile)))) ||
            ['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          // Invalid invocation / missing executable is infrastructure failure, not work.
          task.attempts--;
          task.totalAttempts!--;
          state.runs--;
          launch.counted = false;
          await save();
          throw new AgentLaunchError(`AI CLI could not start. Fix the configuration and restart.\n${task.error}`);
        }
      } finally { launch.finishedAt = Date.now(); await progress.close(); await save(); }
      if (before && !quota) { // A quota failure is already refunded.
        try {
          const after = await remoteHead();
          if (after && after !== before) {
            await git(['fetch', 'origin', after]);
            await git(['merge-base', '--is-ancestor', before, after]);
            task.attempts--;
            launch.counted = false;
            log(`#${task.issue} pushed a new commit; attempt refunded`);
          }
        } catch (error) { log(`Could not verify pushed progress: ${String(error)}`); }
      }
      // CLI exit is not evidence of completion. Reconcile with GitHub next tick.
      await save();
    };

    const tick = async () => {
      await command('git', ['fetch', 'origin', config.base], { cwd: root, signal: abort.signal });
      const baseCode = await codeAt(`origin/${config.base}`);
      if (startupCode.some ( (hash, index) => hash !== baseCode[index])) {
        state.codeWarning = '管理プログラムのコードが更新された。再起動が必要';
        log(state.codeWarning);
      } else delete state.codeWarning;
      await save();
      const day = new Date().toISOString().slice(0, 10);
      if (day !== state.day) { state.day = day; state.runs = 0; await save(); }
      if (await runManager(false)) return;
      for (const task of state.tasks) {
        if (task.phase === 'done') {
          try { await cleanupMerged(task, root, stateDir, config.repo, config.base, undefined, reason => log(`#${task.issue} 片付けを保留: ${reason}`)); }
          catch (error) { log(`#${task.issue} 片付けを保留: ${String(error)}`); }
          continue;
        }
        const item = await issue(task.issue);
        if (item.state === 'CLOSED') { log(`#${task.issue} 完了（Issue はクローズ済み）`); task.phase = 'done'; await save(); continue; }
        if (task.phase !== 'claiming' && activeClaims(item.comments)[0] !== task.claim) {
          log(`#${task.issue}: claim no longer owned; leaving the task untouched.`);
          task.phase = 'done';
          await save();
          continue;
        }
        if (hasLabel(item, 'status:paused')) {
          const marker = '<!-- agent-runner-paused-notice -->';
          log(`#${task.issue} status:paused: 人がラベルを外すまで再開しません`);
          if (!item.comments.some(c => c.body.includes(marker)))
            await comment(task.issue, `${marker}\n管理プログラムは、人が status:paused を外すまでこの Issue を再開しません。`);
          continue;
        }
        // Only worker-originated waits are automatic. Runner-originated stops (phase
        // blocked) require explicit intervention even if old dependencies are closed.
        if (task.phase === 'working' && hasLabel(item, 'status:blocked') &&
            !hasLabel(item, 'needs-approval') &&
            !item.labels.some(l => l.name.startsWith('status:') && l.name !== 'status:blocked')) {
          const deps = dependencies(item.body);
          const resolved = deps.length > 0 && (await Promise.all(deps.map(number => issue(number))))
            .every(dep => dep.state === 'CLOSED' && !hasLabel(dep, 'needs-approval'));
          const pulls = resolved ? await prs(task) : [];
          if (resolved && !pulls.some(pr => pr.state === 'OPEN' && hasLabel(pr, 'needs-approval'))) {
            await status(task.issue, 'status:ready');
            task.attempts = 0;
            await save();
            await status(task.issue, 'status:in-progress');
            item.labels = item.labels.filter(l => !l.name.startsWith('status:'));
            item.labels.push({ name: 'status:in-progress' });
          }
        }
        if (task.phase === 'blocked') {
          if (!hasLabel(item, 'status:ready') || hasLabel(item, 'needs-approval')) { log(`#${task.issue} 保留中（再開指示待ち）`); continue; }
          task.attempts = 0;
          task.totalAttempts = 0;
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
          if (config.autoMerge && canMerge(item, pr, config.base, await ciRuns(pr))) {
            // Recheck immediately; gh's SHA guard rejects head updates during merge.
            const freshIssue = await issue(task.issue);
            const fresh = (await prs(task)).find(p => p.number === pr.number);
            if (fresh && canMerge(freshIssue, fresh, config.base, await ciRuns(fresh)) && await baseSafety(fresh)) {
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
        if (await run(task, item, pr) === 'limited') continue;
        return; // At most one worker per tick.
      }
      // PM has its own budget; it may run even when worker runs are exhausted.
      if (state.runs >= config.maxRunsPerDay) { log(`日次起動上限 ${state.runs}/${config.maxRunsPerDay}。UTC の日付更新待ち`); return; }
      for (const candidate of (await ready()).sort((a, b) => a.number - b.number)) {
        if (state.tasks.some(task => task.issue === candidate.number) || !await eligible(candidate)) continue;
        // Do not claim work its CLI cannot start; claims would pile up during a quota wait.
        if (limited(workerFor(candidate).agent)) continue;
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
  const defaults = { agent: 'codex', base: 'main', pollSeconds: 60, timeoutSeconds: 3600, maxAttempts: 3, maxTotalAttempts: 10, maxRunsPerDay: 12, limitWaitSeconds: 3600, autoMerge: true, agentArgs: [], workerOverrides: {} };
  const config = { ...defaults, ...raw } as unknown as Config;
  for (const key of Object.keys(raw)) if (![...Object.keys(defaults), 'repo', 'milestone', 'manager'].includes(key)) throw new Error(`Unknown config key: ${key}`);
  config.manager = managerConfig(raw.manager);
  if (!config.workerOverrides || typeof config.workerOverrides !== 'object' || Array.isArray(config.workerOverrides)) throw new Error('Invalid workerOverrides');
  for (const [label, override] of Object.entries(config.workerOverrides)) {
    if (!label || !override || typeof override !== 'object' || Array.isArray(override) || Object.keys(override).some(key => !['agent', 'agentArgs'].includes(key)) ||
      (override.agent !== undefined && !['codex', 'claude'].includes(override.agent)) ||
      (override.agentArgs !== undefined && (!Array.isArray(override.agentArgs) || !override.agentArgs.every(arg => typeof arg === 'string')))) throw new Error(`Invalid worker override: ${label}`);
  }
  if (typeof config.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(config.repo)) throw new Error('repo must be owner/repository');
  if (!['codex', 'claude'].includes(config.agent)) throw new Error('agent must be codex or claude');
  if (typeof config.base !== 'string' || !/^[\w][\w./-]*$/.test(config.base)) throw new Error('Invalid base branch');
  if (config.milestone !== undefined && (typeof config.milestone !== 'string' || !config.milestone)) throw new Error('Invalid milestone');
  for (const key of ['pollSeconds', 'timeoutSeconds', 'maxAttempts', 'maxTotalAttempts', 'maxRunsPerDay', 'limitWaitSeconds'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (typeof config.autoMerge !== 'boolean' || !Array.isArray(config.agentArgs) || !config.agentArgs.every(arg => typeof arg === 'string')) throw new Error('Invalid autoMerge or agentArgs');
  return config;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
