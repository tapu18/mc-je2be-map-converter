import { expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followProgress, progressMessages } from './progress.ts';

it('summarizes Codex actions without dumping tool output or reasoning', () => {
  expect(progressMessages(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'CIを確認しています。' } })))
    .toEqual(['CIを確認しています。']);
  expect(progressMessages(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm run check' } })))
    .toEqual(['実行: npm run check']);
  expect(progressMessages(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', status: 'failed', exit_code: 1, aggregated_output: 'huge output' } })))
    .toEqual(['コマンド失敗 (exit 1): npm test']);
  expect(progressMessages(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'internal reasoning' } }))).toEqual([]);
  expect(progressMessages('CLI diagnostic')).toEqual(['CLI: CLI diagnostic']);
});

it('summarizes Claude streaming text, tool calls and errors', () => {
  expect(progressMessages(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'テストします' },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
  ] } }))).toEqual(['テストします', 'ツール: Bash npm test']);
  expect(progressMessages(JSON.stringify({ type: 'result', is_error: true, result: 'failed' }))).toEqual(['AI エラー: failed']);
});

it('streams appended lines and flushes split UTF-8 and an unterminated final line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'je2be-progress-'));
  const path = join(directory, 'worker.log');
  const messages: string[] = [];
  const progress = await followProgress(path, text => messages.push(text));
  try {
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '確認中です' } });
    const bytes = Buffer.from(line + '\n');
    const split = bytes.indexOf(Buffer.from('確')) + 1;
    await appendFile(path, bytes.subarray(0, split));
    // Force one read with an incomplete multi-byte character.
    await new Promise(resolve => setTimeout(resolve, 600));
    await appendFile(path, bytes.subarray(split));
    await expect.poll(() => messages).toContain('確認中です');
    await appendFile(path, 'last diagnostic');
    await progress.close();
    expect(messages).toEqual(['確認中です', 'CLI: last diagnostic']);
    expect(await readFile(path, 'utf8')).toBe(line + '\nlast diagnostic');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('reports elapsed time and last activity while the worker is silent, and clears timers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'je2be-progress-'));
  vi.useFakeTimers();
  const messages: string[] = [];
  const progress = await followProgress(join(directory, 'worker.log'), text => messages.push(text));
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages).toContain('実行中 1分 / ログ更新 60秒前 / 直近: AI の応答待ち');
    await progress.close();
    const count = messages.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(messages).toHaveLength(count);
  } finally { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); }
});
