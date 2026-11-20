import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredChecks } from './policy.ts';
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
  const initial: { issues: Issue[]; prs: PullRequest[]; calls: string[][]; tree?: string; branch?: string; workerFails?: boolean; launchFails?: boolean } = {
    issues: [{ number: 7, title: 'Task', body: '### 完了条件\n- [ ] Tested', state: 'OPEN', labels: [{ name: 'status:ready' }], comments: [] }],
    prs: [], calls: [],
  };
  await writeFile(dataPath, JSON.stringify(initial));
  const script = String.raw`
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
const file = process.env.RUNNER_FIXTURE;
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
  else if (args[0] === 'worktree' && args[1] === 'list') out(d.tree ? 'worktree ' + d.tree + '\nbranch refs/heads/' + d.branch + '\n' : '');
  else if (args[0] === 'worktree' && args[1] === 'add') { d.branch = args[3]; d.tree = args[4]; mkdirSync(d.tree, {recursive:true}); }
  else if (args[0] !== 'fetch') throw Error('Unexpected git ' + args);
} else if (tool === 'gh') {
  if (args[0] === 'repo') out({nameWithOwner: 'owner/repo'});
  else if (args[0] === 'pr' && args[1] === 'list') out(d.prs);
  else if (args[0] === 'pr' && args[1] === 'merge') { d.prs[0].state = 'MERGED'; d.issues[0].state = 'CLOSED'; }
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
    writeFileSync(file, JSON.stringify(d));
    console.error('error: invalid CLI arguments');
    process.exit(2);
  }
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  if (!prompt.includes('Issue #7')) throw Error('No prompt supplied via stdin');
  out({type:'item.completed', item:{type:'agent_message', text:'テストとPR作成を進めています'}});
  if (!d.workerFails) d.prs = [{number:9,state:'OPEN',isDraft:false,baseRefName:'main',headRefName:d.branch,headRefOid:'abc',mergeStateStatus:'CLEAN',reviewDecision:'',labels:[],closingIssuesReferences:[{number:7}],statusCheckRollup:[]}];
} else throw Error('Unexpected executable ' + tool);
writeFileSync(file, JSON.stringify(d));
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
  return { root, config, run, load, update, state };
}

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

it('claims, resumes in its own worktree, waits for all CI, and merges with a SHA guard', async () => {
  const f = await fixture();
  await f.run(); // claim only
  expect((await f.load()).calls.some(call => call[0] === 'codex')).toBe(false);
  const result = await f.run(); // same persisted task, new process
  expect(result.stdout).toContain('#7 テストとPR作成を進めています');
  expect((await f.load()).calls.filter(call => call[0] === 'codex')).toHaveLength(1);
  await f.run(); // absent CI must not merge or launch a second worker
  expect((await f.load()).calls.some(call => call[2] === 'merge')).toBe(false);
  await f.update(d => { d.prs[0]!.statusCheckRollup = requiredChecks.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })); });
  await f.run();
  const calls = (await f.load()).calls;
  expect(calls.find(call => call[2] === 'merge')).toContain('--match-head-commit');
  expect(calls.find(call => call[2] === 'merge')).toContain('abc');
  await f.run();
  expect((await f.state()).tasks[0].phase).toBe('done');
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

it('gives up a lost claim without starting a worker on the next tick', async () => {
  const f = await fixture();
  await f.run();
  await f.update(d => { d.issues[0]!.comments.unshift({ body: 'claim: competing-worker' }); });
  await f.run();
  await f.run();
  expect((await f.load()).calls.some(call => call[0] === 'codex')).toBe(false);
});

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
  await writeFile(f.config, JSON.stringify({ repo: 'owner/repo', agent: 'claude' }));
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
    d.prs[0]!.statusCheckRollup = requiredChecks.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));
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
