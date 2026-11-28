import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Issue, PullRequest } from './policy.ts';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../agent-runner.ts', import.meta.url));
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Real CLI entrypoint and state files; executable test doubles never contact GitHub or an AI service.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'je2be-runner-'));
  temporary.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const dataPath = join(root, 'fixture.json');
  const initial: { issues: Issue[]; prs: PullRequest[]; calls: string[][]; tree?: string; branch?: string; baseCode?: string; remoteHead?: string; pushHead?: string; workerFails?: boolean; managerLog?: string[]; launchFails?: boolean; managerFails?: boolean; managerPrompts?: string[]; workerPrompts?: string[]; workerLog?: string[]; runs?: { headSha: string; event: string; status: string; conclusion: string | null }[] } = {
    issues: [{ number: 7, title: 'Task', body: '### 完了条件\n- [ ] Tested', state: 'OPEN', labels: [{ name: 'status:ready' }], comments: [] }],
    prs: [], calls: [],
  };
  await writeFile(dataPath, JSON.stringify(initial));
  const script = String.raw`
import { readFileSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { basename } from 'node:path';
const file = process.env.RUNNER_FIXTURE;
// Multiple mocked commands can run concurrently. Serialize their read-modify-write
// transactions so no command reads a truncated file or loses another command's update.
const lock = file + '.lock';
for (;;) {
  try { mkdirSync(lock); break; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const save = d => { writeFileSync(file, JSON.stringify(d)); rmdirSync(lock); };
const d = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const tool = basename(process.argv[1]);
d.calls.push([tool, ...args]);
const out = value => console.log(typeof value === 'string' ? value : JSON.stringify(value));
const value = name => args[args.indexOf(name) + 1];
const has = (item, name) => item.labels.some(l => l.name === name);
if (tool === 'git') {
  if (args[1] === '--show-toplevel') out(process.env.RUNNER_ROOT);
  else if (args[1] === '--git-common-dir') out('.git');
  else if (args[0] === 'rev-parse' && args[1].includes(':tools/agent-runner.ts')) out(args[1].startsWith('HEAD:') ? 'file\ntree' : (d.baseCode ?? 'file\ntree'));
  else if (args[0] === 'rev-parse' && args[1].startsWith('origin/')) out(args[1] === 'origin/main' ? 'base' : 'abc');
  else if (args[0] === 'merge-base') out('base');
  else if (args[0] === 'diff') {}
  else if (args[0] === 'ls-remote') out(args[1] === '--heads' ? (d.remoteHead ? d.remoteHead + ' refs/heads/' + d.branch : '') : 'base refs/heads/main');
  else if (args[0] === 'worktree' && args[1] === 'list') out(d.tree ? 'worktree ' + d.tree + '\nbranch refs/heads/' + d.branch + '\n' : '');
  else if (args[0] === 'worktree' && args[1] === 'add') { d.branch = args[3]; d.tree = args[4]; mkdirSync(d.tree, {recursive:true}); }
  else if (args[0] !== 'fetch') throw Error('Unexpected git ' + args);
} else if (tool === 'gh') {
  if (args[0] === 'repo') out({nameWithOwner: 'owner/repo'});
  else if (args[0] === 'run' && args[1] === 'list') out(args.includes('--event') ? [{headSha:'base',event:'push',status:'completed',conclusion:'success'}] : (d.runs ?? [{headSha:'abc',event:'pull_request',status:'completed',conclusion:'success'}]));
  else if (args[0] === 'pr' && args[1] === 'list') out(d.prs);
  else if (args[0] === 'pr' && args[1] === 'merge') { d.prs[0].state = 'MERGED'; d.issues[0].state = 'CLOSED'; }
  else if (args[0] === 'api' && args[1].includes('labels=status%3Ablocked')) {
    const blocked = d.issues.filter(i => has(i, 'status:blocked') && i.state === 'OPEN');
    out([blocked.slice(0, 1), blocked.slice(1)]);
  }
  else if (args[0] === 'issue') {
    const item = d.issues.find(i => i.number === Number(args[2]));
    if (args[1] === 'list') out(d.issues.filter(i => has(i, 'status:ready') && i.state === 'OPEN'));
    else if (args[1] === 'view') out(item);
    else if (args[1] === 'comment') item.comments.push({body: value('--body')});
    else if (args[1] === 'edit') {
      for (let i=3; i<args.length; i++) {
        if (args[i] === '--add-label' && !has(item,args[i+1])) item.labels.push({name:args[i+1]});
        if (args[i] === '--remove-label') item.labels = item.labels.filter(l => l.name !== args[i+1]);
      }
    } else throw Error('Unexpected gh ' + args);
  } else throw Error('Unexpected gh ' + args);
} else if (tool === 'codex' || tool === 'claude') {
  if (d.launchFails || (tool === 'codex' && args.includes('--approve-for-me') && args.includes('--sandbox'))) {
    save(d);
    console.error('error: invalid CLI arguments');
    process.exit(2);
  }
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  if (prompt.includes('の PM 巡回です')) {
    (d.managerPrompts ??= []).push(prompt);
    if (d.managerLog) { for (const line of d.managerLog) out(line); save(d); process.exit(1); }
    out({type:'item.completed', item:{type:'agent_message',text:'PM報告: 次は #7。承認待ちを確認しました。'}});
    if (d.managerFails) process.exitCode = 1;
  } else {
    if (!prompt.includes('Issue #7')) throw Error('No prompt supplied via stdin');
    (d.workerPrompts ??= []).push(prompt);
    if (d.pushHead) d.remoteHead = d.pushHead;
    if (d.workerLog) { for (const line of d.workerLog) out(line); save(d); process.exit(1); }
    out({type:'item.completed', item:{type:'agent_message', text:'テストとPR作成を進めています'}});
    if (!d.workerFails) d.prs = [{number:9,state:'OPEN',isDraft:false,baseRefName:'main',headRefName:d.branch,headRefOid:'abc',mergeStateStatus:'CLEAN',reviewDecision:'',labels:[],closingIssuesReferences:[{number:7}],statusCheckRollup:[]}];
  }
} else throw Error('Unexpected executable ' + tool);
save(d);
if ((tool === 'codex' || tool === 'claude') && d.workerFails) process.exitCode = 1;
`;
  for (const tool of ['git', 'gh', 'codex', 'claude']) {
    await writeFile(join(bin, tool), `#!${process.execPath}\n${script}`, { mode: 0o755 });
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ repo: 'owner/repo', maxAttempts: 2 }));
  const load = async () => JSON.parse(await readFile(dataPath, 'utf8')) as typeof initial;
  const update = async (fn: (d: typeof initial) => void) => { const d = await load(); fn(d); await writeFile(dataPath, JSON.stringify(d)); };
  const run = (...args: string[]) => exec(process.execPath, [runner, '--config', config, '--once', ...args], {
    cwd: root, env: { ...process.env, PATH: bin + delimiter + process.env.PATH, RUNNER_ROOT: root, RUNNER_FIXTURE: dataPath }, timeout: 15_000,
  }).catch(async (error: { message: string; stdout: string; stderr: string; signal: string; code: unknown }) => {
    throw new Error(`${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}\nsignal: ${error.signal}; code: ${error.code}`);
  });
  const state = async () => JSON.parse(await readFile(join(root, '.git', 'agent-runner', 'state.json'), 'utf8'));
  const updateState = async (fn: (d: any) => void) => {
    const d = await state(); fn(d);
    await writeFile(join(root, '.git', 'agent-runner', 'state.json'), JSON.stringify(d));
  };
  return { root, config, run, load, update, state, updateState };
}

it('refunds pushed progress but counts idle runs and enforces the total limit', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', maxAttempts: 2, maxTotalAttempts: 3 }));
  await f.update(d => { d.workerFails = true; d.pushHead = 'commit1'; });
  await f.run(); // Claim the issue before launching the worker.
  await f.run();
  expect((await f.state()).tasks[0]).toMatchObject({ attempts: 0, totalAttempts: 1, launches: [{ counted: false }] });
  await f.update(d => { delete d.pushHead; });
  await f.run();
  expect((await f.state()).tasks[0]).toMatchObject({ attempts: 1, totalAttempts: 2 });
  await f.update(d => { d.pushHead = 'commit2'; });
  await f.run();
  expect((await f.state()).tasks[0]).toMatchObject({ attempts: 1, totalAttempts: 3 });
  await f.run();
  expect((await f.state()).tasks[0].phase).toBe('blocked');
  expect((await f.load()).workerPrompts).toHaveLength(3);
}, 20_000);

it('warns in the terminal, state, and PM prompt when base code changes', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', manager: { enabled: true } }));
  await f.update(d => { d.baseCode = 'new-file\ntree'; });
  const warning = '管理プログラムのコードが更新された。再起動が必要';
  expect((await f.run()).stdout).toContain(warning);
  expect((await f.state()).codeWarning).toBe(warning);
  expect((await f.load()).managerPrompts?.[0]).toContain(warning);
  await f.update(d => { d.baseCode = 'file\ntree'; });
  expect((await f.run()).stdout).not.toContain(warning);
  expect((await f.state()).codeWarning).toBeUndefined();
});

it('dry-run only reads; excludes other claims and unclosed dependencies', async () => {
  const f = await fixture();
  await f.update(d => {
    d.issues[0]!.body = 'Depends on: #8';
    d.issues.push({ ...d.issues[0]!, number: 8, body: '', comments: [{ body: 'claim: other' }] });
  });
  const { stdout } = await f.run('--dry-run');
  expect(stdout).toContain('#7 skip');
  expect(stdout).toContain('#8 skip');
  await expect(access(join(f.root, '.git'))).rejects.toThrow();
  expect((await f.load()).calls.every(call => !call.some(arg => ['edit', 'comment', 'exec', 'merge'].includes(arg)))).toBe(true);
});

it('promotes only unclaimed issues blocked solely on closed dependencies and comments once', async () => {
  const f = await fixture();
  await f.update(d => {
    const base = d.issues[0]!;
    const blocked = { ...base, body: 'Depends on: #8, #9', labels: [{ name: 'status:blocked' }] };
    d.issues.push(
      { ...base, number: 8, state: 'CLOSED' },
      { ...base, number: 9, state: 'OPEN', labels: [] },
      { ...blocked, number: 10 },
      { ...blocked, number: 11, body: blocked.body + '\n\nBlocked: PM が子 Issue に分けるまで待つ' },
      { ...blocked, number: 12, comments: [{ body: 'claim: other' }] },
      { ...blocked, number: 13, labels: [...blocked.labels, { name: 'needs-approval' }] },
      { ...blocked, number: 14, body: '関連: #8, #9' },
      { ...blocked, number: 15, labels: [...blocked.labels, { name: 'status:paused' }] },
      { ...blocked, number: 16, body: 'Depends on: #999' },
      { ...blocked, number: 17, body: 'Depends on: #8', comments: [
        { body: '<!-- agent-runner-dependencies-closed -->\n前回の巡回で通知済み' },
      ] },
    );
  });
  await f.run('--dry-run');
  expect((await f.load()).calls.some(call => call.includes('--paginate'))).toBe(false);
  await f.run();
  const readIssue = async (number: number) => (await f.load()).issues.find(item => item.number === number)!;
  expect((await readIssue(10)).labels).toEqual([{ name: 'status:blocked' }]);
  expect((await readIssue(17)).labels).toEqual([{ name: 'status:ready' }]);
  expect((await readIssue(17)).comments).toHaveLength(1);
  await f.update(d => { d.issues.find(item => item.number === 9)!.state = 'CLOSED'; });
  await f.run();
  await f.run();
  expect((await readIssue(10)).labels).toEqual([{ name: 'status:ready' }]);
  const notices = (await readIssue(10)).comments.filter(c => c.body.includes('agent-runner-dependencies-closed'));
  expect(notices).toEqual([{ body: expect.stringContaining('#8、#9') }]);
  for (const number of [11, 12, 13, 14, 15, 16]) {
    expect((await readIssue(number)).labels).toContainEqual({ name: 'status:blocked' });
    expect((await readIssue(number)).labels).not.toContainEqual({ name: 'status:ready' });
  }
}, 15_000);

it('claims, resumes in its own worktree, waits for all CI, and merges with a SHA guard', async () => {
  const f = await fixture();
  await f.run(); // claim only
  expect((await f.load()).calls.some(call => call[0] === 'codex')).toBe(false);
  const result = await f.run(); // same persisted task, new process
  expect(result.stdout).toContain('#7 テストとPR作成を進めています');
  expect((await f.load()).calls.filter(call => call[0] === 'codex')).toHaveLength(1);
  expect((await f.load()).workerPrompts![0]).toContain('status:paused を付けず');
  expect((await f.load()).workerPrompts![0]).toContain('進捗と再開手順');
  await f.run(); // absent CI must not merge or launch a second worker
  expect((await f.load()).calls.some(call => call[2] === 'merge')).toBe(false);
  await f.update(d => { d.prs[0]!.statusCheckRollup = ['check', 'servers / scenarios-1', 'servers / result'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })); });
  await f.run();
  const calls = (await f.load()).calls;
  expect(calls.find(call => call[2] === 'merge')).toContain('--match-head-commit');
  expect(calls.find(call => call[2] === 'merge')).toContain('abc');
  await f.run();
  expect((await f.state()).tasks[0].phase).toBe('done');
}, 20_000);

it('reports a paused owned issue once across polls and restarts without launching the worker', async () => {
  const f = await fixture();
  await f.run();
  await f.run();
  await f.update(d => { d.issues[0]!.labels.push({ name: 'status:paused' }, { name: 'needs-approval' }); });
  expect((await f.run()).stdout).toContain('人がラベルを外すまで再開しません');
  await f.run();
  const data = await f.load();
  expect(data.issues[0]!.comments.filter(c => c.body.includes('agent-runner-paused-notice'))).toHaveLength(1);
  expect(data.issues[0]!.comments.find(c => c.body.includes('agent-runner-paused-notice'))!.body).toContain('人が status:paused を外すまで');
  expect(data.calls.filter(call => call[0] === 'codex')).toHaveLength(1);
}, 20_000);

it('waits for the current CI workflow even when renamed checks have passed', async () => {
  const f = await fixture();
  await f.run();
  await f.run();
  await f.update(d => {
    d.prs[0]!.statusCheckRollup = [{ name: 'servers / result', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    d.runs = [];
  });
  await f.run();
  expect((await f.load()).calls.some(call => call[2] === 'merge')).toBe(false);
  await f.update(d => { d.runs = [{ headSha: 'abc', event: 'pull_request', status: 'completed', conclusion: 'success' }]; });
  await f.run();
  expect((await f.load()).calls.some(call => call[2] === 'merge')).toBe(true);
}, 20_000);

it('bounds worker retries, preserves state, and resumes a blocked task when made ready', async () => {
  const f = await fixture();
  await f.update(d => { d.workerFails = true; });
  await f.run();
  await f.run();
  await f.run();
  await f.run();
  expect((await f.state()).tasks[0].phase).toBe('blocked');
  expect((await f.load()).calls.filter(call => call[0] === 'codex')).toHaveLength(2);
  await f.update(d => { d.workerFails = false; d.issues[0]!.labels = [{ name: 'status:ready' }]; });
  await f.run();
  expect((await f.state()).tasks[0].attempts).toBe(1);
  expect((await f.load()).calls.filter(call => call[0] === 'codex')).toHaveLength(3);
}, 20_000);

it('resumes a worker dependency wait only after all dependencies and approvals are resolved', async () => {
  const f = await fixture();
  await f.update(d => { d.workerFails = true; });
  await f.run();
  await f.run();
  await f.update(d => {
    d.workerFails = true;
    d.issues[0]!.body = 'Depends on: #8, #9';
    d.issues[0]!.labels = [{ name: 'status:blocked' }];
    d.issues.push({ ...d.issues[0]!, number: 8, state: 'CLOSED', labels: [], comments: [] });
    d.issues.push({ ...d.issues[0]!, number: 9, state: 'OPEN', labels: [], comments: [] });
  });
  await f.run();
  await f.update(d => { d.issues[2]!.state = 'CLOSED'; d.issues[2]!.labels = [{ name: 'needs-approval' }]; });
  await f.run();
  await f.update(d => { d.issues[2]!.labels = []; d.issues[0]!.labels.push({ name: 'needs-approval' }); });
  await f.run();
  expect((await f.load()).calls.filter(call => call[0] === 'codex')).toHaveLength(1);
  await f.update(d => { d.issues[0]!.labels = [{ name: 'status:blocked' }]; });
  await f.run();
  const data = await f.load();
  expect(data.calls.filter(call => call[0] === 'codex')).toHaveLength(2);
  expect(data.calls.some(call => call.includes('status:ready'))).toBe(true);
  expect(data.tree).toBe((await f.state()).tasks[0].worktree);
}, 20_000);

it('keeps a blocked worker stopped without explicit dependencies or with PR approval pending', async () => {
  const f = await fixture();
  await f.update(d => { d.workerFails = true; });
  await f.run();
  await f.run();
  await f.update(d => { d.issues[0]!.labels = [{ name: 'status:blocked' }]; });
  await f.run();
  await f.update(d => {
    d.issues[0]!.body = 'Depends on: #8';
    d.issues.push({ ...d.issues[0]!, number: 8, state: 'CLOSED', labels: [], comments: [] });
    d.prs = [{ number: 9, state: 'OPEN', isDraft: true, baseRefName: 'main', headRefName: d.branch!, headRefOid: 'abc', mergeStateStatus: 'CLEAN', reviewDecision: '', labels: [{ name: 'needs-approval' }], closingIssuesReferences: [], statusCheckRollup: [] }];
  });
  await f.run();
  expect((await f.load()).calls.filter(call => call[0] === 'codex')).toHaveLength(1);
  expect((await f.load()).issues[0]!.labels).toContainEqual({ name: 'status:blocked' });
}, 20_000);

it('gives up a lost claim without starting a worker on the next tick', async () => {
  const f = await fixture();
  await f.run();
  await f.update(d => { d.issues[0]!.comments.unshift({ body: 'claim: competing-worker' }); });
  await f.run();
  await f.run();
  expect((await f.load()).calls.some(call => call[0] === 'codex')).toBe(false);
}, 20_000);

it('respects the daily run limit without discarding the active task', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', maxRunsPerDay: 1 }));
  await f.update(d => { d.workerFails = true; });
  await f.run();
  await f.run();
  await f.run();
  expect((await f.load()).calls.filter(call => call[0] === 'codex')).toHaveLength(1);
  expect((await f.state()).tasks[0].phase).toBe('working');
});

it('uses claude when configured and rejects an existing lock', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', agent: 'claude', agentArgs: ['--permission-mode', 'auto'] }));
  await f.run();
  await f.run();
  expect((await f.load()).calls.find(call => call[0] === 'claude')).toContain('-p');
  const lock = join(f.root, '.git', 'agent-runner', 'lock');
  await writeFile(lock, '{"pid":123}');
  await expect(f.run()).rejects.toThrow('Runner lock exists');
  expect(await readFile(lock, 'utf8')).toBe('{"pid":123}');
});

it('leaves passing approval waits alone and honors autoMerge=false', async () => {
  const f = await fixture();
  await f.run();
  await f.run();
  await f.update(d => {
    d.issues[0]!.labels.push({ name: 'needs-approval' });
    d.prs[0]!.statusCheckRollup = ['check', 'servers / scenarios-1', 'servers / result'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));
  });
  await f.run();
  expect((await f.load()).calls.some(call => call[2] === 'merge')).toBe(false);
  await f.update(d => { d.issues[0]!.labels = [{ name: 'status:in-progress' }]; });
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', autoMerge: false }));
  await f.run();
  expect((await f.load()).calls.some(call => call[2] === 'merge')).toBe(false);
  expect((await f.load()).calls.filter(call => call[0] === 'codex')).toHaveLength(1);
});

it('runs with the actual example approval flag without a conflicting sandbox', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', agentArgs: ['--approve-for-me'] }));
  await f.run();
  await f.run();
  expect((await f.load()).prs).toHaveLength(1);
  expect((await f.state()).tasks[0].error).toBeUndefined();
});

it('stops the loop on CLI startup errors, shows diagnostics and refunds the attempt', async () => {
  const f = await fixture();
  await f.run();
  await f.update(d => { d.launchFails = true; });
  await expect(f.run()).rejects.toThrow('error: invalid CLI arguments');
  const state = await f.state();
  expect(state.runs).toBe(0);
  expect(state.tasks[0].attempts).toBe(0);
  expect(state.tasks[0].phase).toBe('working');
  expect((await f.load()).issues[0]!.labels.some(label => label.name === 'status:blocked')).toBe(false);
  await f.update(d => { d.launchFails = false; });
  await f.run();
  expect((await f.load()).prs).toHaveLength(1);
});

it('refunds a structured CLI failure before work and holds that CLI without stopping', async () => {
  const f = await fixture();
  await f.run();
  await f.update(d => { d.workerLog = [
    JSON.stringify({ type: 'thread.started', thread_id: 'test' }),
    JSON.stringify({ type: 'turn.failed', error: { message: "The ' gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account." } }),
  ]; });
  expect((await f.run()).stdout).toContain('codex が作業前に失敗');
  const state = await f.state();
  expect(state.runs).toBe(0);
  expect(state.tasks[0].attempts).toBe(0);
  expect(state.tasks[0].error).toContain('model is not supported');
  expect(state.tasks[0].launches[0]).toMatchObject({ counted: false });
  expect(state.tasks[0].launches[0].limited).toBeUndefined();
  expect(state.limits.codex).toMatchObject({ kind: 'failure' });
  expect(state.limits.codex.until - Date.now()).toBeLessThanOrEqual(3600_000);
  expect((await f.load()).issues[0]!.labels.some(label => label.name === 'status:blocked')).toBe(false);
  expect((await f.run()).stdout).toContain('起動失敗のため見送り中');
  expect((await f.load()).workerPrompts).toHaveLength(1);
});

it('counts a failure after work and refunds an early error event', async () => {
  const f = await fixture();
  await f.run();
  await f.update(d => { d.workerLog = [JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }), JSON.stringify({ type: 'turn.failed' })]; });
  await f.run();
  expect((await f.state()).runs).toBe(1);
  await f.update(d => { d.workerLog = [JSON.stringify({ type: 'error', message: 'authentication failed' })]; });
  await f.run();
  expect((await f.state()).limits.codex).toMatchObject({ kind: 'failure' });
  expect((await f.state()).runs).toBe(1);
  expect((await f.state()).tasks[0].attempts).toBe(1);
});

it.each([['--model', ' bad'], ['--model=bad '], ['--model', "'bad'"], ['--model'], ['-m', ' bad'], ['-m']])('rejects invalid model arguments before starting: %s', async (...args) => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', agentArgs: args }));
  await expect(f.run()).rejects.toThrow(`Invalid ${args[0]!.split('=')[0]} value`);
  await expect(access(join(f.root, '.git'))).rejects.toThrow();
});

// Shape of a real Claude Code 2.1 log (#395): the text alone did not match the quota pattern.
const claudeQuota = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }),
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 7200, rateLimitType: 'five_hour' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 3:50am (Asia/Tokyo)" }] }, error: 'rate_limit' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', result: "You've hit your 5-hour limit · resets 3:50am (Asia/Tokyo)" }),
];

const quota = [
  JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
  JSON.stringify({ type: 'turn.failed', error: { message: 'You’ve hit your usage limit. Upgrade to Pro or try again at 2:21 PM.' } }),
];

it('waits for the Claude 5-hour limit until its structured reset time (#395)', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', agent: 'claude', agentArgs: ['--permission-mode', 'auto'] }));
  await f.run();
  await f.update(d => { d.workerLog = claudeQuota; });
  expect((await f.run()).stdout).toContain('claude の使用量の上限');
  const state = await f.state();
  expect(state.runs).toBe(0);
  expect(state.tasks[0].launches[0]).toMatchObject({ counted: false, limited: true });
  const resetsAt = JSON.parse(claudeQuota[1]!).rate_limit_info.resetsAt * 1000;
  expect(state.limits.claude).toMatchObject({ until: resetsAt + 60_000, kind: 'quota' });
});

it('waits for a worker CLI quota without stopping the runner or counting the launch', async () => {
  const f = await fixture();
  await f.run();
  await f.update(d => { d.workerLog = quota; });
  const hit = await f.run();
  expect(hit.stdout).toContain('codex の使用量の上限');
  const state = await f.state();
  expect(state.runs).toBe(0);
  expect(state.tasks[0].attempts).toBe(0);
  expect(state.tasks[0].launches[0]).toMatchObject({ counted: false, limited: true });
  const until = state.limits.codex.until;
  expect(until).toBeGreaterThan(Date.now());
  expect(until - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
  expect((await f.load()).issues[0]!.labels.some(label => label.name === 'status:blocked')).toBe(false);
  await f.update(d => { delete d.workerLog; });
  expect((await f.run()).stdout).toContain('使用量の上限で見送り中');
  expect((await f.load()).workerPrompts).toHaveLength(1);
  expect((await f.run('--report')).stdout).toContain('"limit":"codex"');
  await f.updateState(d => { d.limits.codex.until = Date.now() - 1; });
  await f.run();
  expect((await f.load()).workerPrompts).toHaveLength(2);
  expect((await f.load()).prs).toHaveLength(1);
});

it('runs another CLI while one waits for its quota and does not claim work for the waiting CLI', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', workerOverrides: { 'agent:claude': { agent: 'claude', agentArgs: ['--permission-mode', 'auto'] } } }));
  await f.update(d => {
    d.issues[0]!.labels.push({ name: 'agent:claude' });
    d.issues.push({ number: 8, title: 'Other', body: '', state: 'OPEN', labels: [{ name: 'status:ready' }], comments: [] });
  });
  await f.run(); // Claim #7.
  await f.updateState(d => { d.limits = { codex: { until: Date.now() + 3600_000, message: 'usage limit' } }; });
  await f.run(); // #7 uses claude, which is not limited.
  const calls = (await f.load()).calls;
  expect(calls.filter(call => call[0] === 'claude')).toHaveLength(1);
  await f.update(d => { d.prs = []; d.issues[0]!.state = 'CLOSED'; });
  await f.run();
  await f.run();
  // #8 would run on codex: it is not claimed while codex waits.
  expect((await f.load()).issues[1]!.comments).toHaveLength(0);
  expect((await f.state()).tasks.map((task: { issue: number }) => task.issue)).toEqual([7]);
});

it('keeps the PM schedule when PM hits a quota and lets workers continue', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', manager: { enabled: true, agent: 'claude', agentArgs: ['--permission-mode', 'auto'] } }));
  await f.update(d => { d.managerLog = [JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|' + Math.floor(Date.now() / 1000 + 600) })]; });
  const hit = await f.run();
  expect(hit.stdout).toContain('claude の使用量の上限');
  const state = await f.state();
  expect(state.manager).toBeUndefined();
  expect(state.limits.claude.until).toBeGreaterThan(Date.now() + 500_000);
  expect(state.tasks).toHaveLength(1); // The worker claimed in the same tick.
});

it('runs PM with independent agent/args and report, persists schedule, then resumes worker tasks', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', manager: {
    enabled: true, agent: 'claude', agentArgs: ['--model', 'manager-model', '--permission-mode', 'auto'], instructions: 'M1の依存を優先',
  } }));
  const result = await f.run();
  expect(result.stdout).toContain('[PM]');
  expect((await f.state()).runs).toBe(0);
  expect((await f.state()).manager.runs).toBe(1);
  expect((await f.state()).tasks).toHaveLength(0);
  const calls = (await f.load()).calls;
  expect(calls.filter(call => call[0] === 'claude')).toHaveLength(1);
  expect(calls.find(call => call[0] === 'claude')).toContain('manager-model');
  expect((await f.load()).managerPrompts![0]).toContain('M1の依存を優先');
  expect(await readFile(join(f.root, '.git', 'agent-runner', 'manager-latest.md'), 'utf8')).toContain('PM報告');
  await f.run(); // Claim work instead of starting PM again.
  await f.run(); // Run codex worker.
  expect((await f.load()).calls.filter(call => call[0] === 'claude')).toHaveLength(1);
  expect((await f.load()).calls.filter(call => call[0] === 'codex')).toHaveLength(1);
  expect((await f.state()).runs).toBe(1);
});

it('runs PM early when no work is available, with cooldown and an independent daily cap', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', manager: { enabled: true, maxRunsPerDay: 2 } }));
  await f.update(d => { d.issues[0]!.labels = [{ name: 'needs-approval' }]; });
  await f.run();
  await f.updateState(d => { d.manager.lastStartedAt -= 3_700_000; d.manager.lastFinishedAt -= 3_700_000; });
  const idle = await f.run();
  expect(idle.stdout).toContain('着手可能な作業なし');
  expect((await f.state()).manager.runs).toBe(2);
  await f.updateState(d => { d.manager.lastStartedAt = 0; d.manager.lastFinishedAt = 0; });
  await f.run();
  expect((await f.load()).managerPrompts).toHaveLength(2);
  await f.updateState(d => { d.manager.day = '2000-01-01'; d.runs = 12; });
  await f.run();
  expect((await f.state()).manager.runs).toBe(1);
  expect((await f.state()).runs).toBe(12);
  expect((await f.load()).managerPrompts).toHaveLength(3);
});

it('keeps PM schedule after failure and stops/refunds startup failures without claiming work', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', manager: { enabled: true } }));
  await f.update(d => { d.launchFails = true; });
  await expect(f.run()).rejects.toThrow('PM CLI could not start');
  expect((await f.state()).manager).toBeUndefined();
  expect((await f.state()).tasks).toHaveLength(0);
  await f.update(d => { d.launchFails = false; d.managerFails = true; });
  await f.run();
  expect((await f.state()).manager.error).toContain('exit 1');
  expect((await f.state()).manager.runs).toBe(1);
  await f.run(); // Cooldown prevents another PM attempt; normal claim is allowed.
  expect((await f.load()).managerPrompts).toHaveLength(1);
});

it('reports PM configuration during dry-run without starting either role', async () => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', manager: { enabled: true, agent: 'claude', agentArgs: ['--permission-mode', 'auto'] } }));
  expect((await f.run('--dry-run')).stdout).toContain('PM: claude');
  await expect(access(join(f.root, '.git'))).rejects.toThrow();
  expect((await f.load()).calls.some(call => ['codex', 'claude'].includes(call[0]!))).toBe(false);
});

it.each([false, true])('selects worker override only when label is present: %s', async (labeled) => {
  const f = await fixture();
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', workerOverrides: { 'model:strong': { agent: 'claude', agentArgs: ['--model', 'example', '--permission-mode', 'auto'] } } }));
  if (labeled) await f.update(d => { d.issues[0]!.labels.push({ name: 'model:strong' }); });
  await f.run();
  await f.run();
  const calls = (await f.load()).calls;
  expect(calls.some(call => call[0] === (labeled ? 'claude' : 'codex') && (labeled ? call.includes('example') : call.includes('exec')))).toBe(true);
  const launch = (await f.state()).tasks[0].launches[0];
  expect(launch.agent).toBe(labeled ? 'claude' : 'codex');
  expect(launch.finishedAt).toBeGreaterThanOrEqual(launch.startedAt);
  const report = await f.run('--report');
  expect(report.stdout).toContain('"issue":7');
  expect(report.stdout).toContain('"merged":false');
  expect(report.stdout).toContain('"durationMs":');
});

it('retains default worker invocation without overrides', async () => {
  const f = await fixture();
  await f.run(); await f.run();
  expect((await f.load()).calls.some(call => call[0] === 'codex' && call.includes('exec'))).toBe(true);
});
