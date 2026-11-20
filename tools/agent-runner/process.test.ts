import { expect, it } from 'vitest';
import { command } from './process.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('collects subprocess output and reports command failures', async () => {
  expect(await command(process.execPath, ['-e', 'process.stdout.write("hello")'], { cwd: process.cwd() })).toBe('hello');
  await expect(command(process.execPath, ['-e', 'console.error("broken");process.exitCode=2'], { cwd: process.cwd() }))
    .rejects.toThrow('exit 2 broken');
});

it('stops a process that exceeds its timeout', async () => {
  await expect(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), timeoutMs: 100 }))
    .rejects.toThrow('stopped / timed out');
});

it('stops a running process when shutdown is requested', async () => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    await expect(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), signal: abort.signal }))
      .rejects.toThrow('stopped / timed out');
  } finally { clearTimeout(timer); }
});

it('includes CLI diagnostics in the exception even when output is redirected to a log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'je2be-command-'));
  const logfile = join(directory, 'worker.log');
  try {
    await expect(command(process.execPath, ['-e', 'console.error("invalid flags");process.exitCode=2'], { cwd: directory, log: logfile }))
      .rejects.toThrow('invalid flags');
    expect(await readFile(logfile, 'utf8')).toContain('invalid flags');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
