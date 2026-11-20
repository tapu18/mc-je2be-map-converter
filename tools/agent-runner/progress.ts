import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const compact = (text: string, limit = 500) => text.replace(/\s+/g, ' ').trim().slice(0, limit);

// Display summaries, not raw JSON, reasoning, or potentially enormous tool output.
export function progressMessages(line: string): string[] {
  let event;
  try { event = JSON.parse(line); }
  catch { return line.trim() ? [`CLI: ${compact(line)}`] : []; }
  if (!event || typeof event !== 'object') return [];
  const item = event.item;
  if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') return [compact(item.text, 2000)];
  if (item?.type === 'command_execution') {
    if (event.type === 'item.started') return [`実行: ${compact(item.command ?? '')}`];
    if (event.type === 'item.completed') return [`コマンド${item.status === 'failed' ? '失敗' : '完了'}${item.exit_code != null ? ` (exit ${item.exit_code})` : ''}: ${compact(item.command ?? '', 250)}`];
  }
  if (event.type === 'item.completed' && item?.type === 'file_change') {
    return [`ファイル変更: ${(item.changes ?? []).map((change: { path: string }) => change.path).join(', ')}`];
  }
  if (event.type === 'item.started' && item?.type === 'mcp_tool_call') return [`ツール: ${item.server ?? ''}/${item.tool ?? ''}`];
  if (event.type === 'turn.started') return ['AI が作業を開始しました'];
  if (event.type === 'turn.completed') return ['AI の応答が完了しました'];
  if (event.type === 'error' || event.type === 'turn.failed') return [`エラー: ${compact(event.message ?? event.error?.message ?? line)}`];
  // Claude --output-format stream-json --verbose
  if (event.type === 'assistant') {
    return (event.message?.content ?? []).flatMap((block: { type: string; text?: string; name?: string; input?: { command?: string; file_path?: string } }) => {
      if (block.type === 'text' && block.text) return [compact(block.text, 2000)];
      if (block.type === 'tool_use') return [`ツール: ${block.name ?? ''} ${compact(block.input?.command ?? block.input?.file_path ?? '')}`];
      return [];
    });
  }
  if (event.type === 'result') return [event.is_error ? `AI エラー: ${compact(event.result ?? line)}` : 'AI の応答が完了しました'];
  return [];
}

/** Observe the same append-only log used by command(), without changing child stdio. */
export async function followProgress(path: string, emit: (message: string) => void) {
  const file = await open(path, 'a+', 0o600);
  let offset = (await file.stat()).size;
  let pending = '';
  const decoder = new StringDecoder('utf8');
  let lastActivity = Date.now();
  let latest = 'AI の応答待ち';
  const report = (line: string) => {
    for (const message of progressMessages(line)) { latest = message; emit(message); }
  };
  const read = async () => {
    const end = (await file.stat()).size;
    while (offset < end) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, end - offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      lastActivity = Date.now();
      pending += decoder.write(chunk.subarray(0, bytesRead));
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        report(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
  };
  // Serialize reads so slow disks never cause duplicate or out-of-order output.
  let reading = Promise.resolve();
  let warned = false;
  const timer = setInterval(() => {
    reading = reading.then(read).catch(error => {
      if (!warned) { emit(`進捗ログの読み取りに失敗: ${String(error)}`); warned = true; }
    });
  }, 500);
  const started = Date.now();
  const heartbeat = setInterval(() => {
    emit(`実行中 ${Math.floor((Date.now() - started) / 60_000)}分 / ログ更新 ${Math.floor((Date.now() - lastActivity) / 1000)}秒前 / 直近: ${compact(latest, 200)}`);
  }, 60_000);
  return {
    async close() {
      clearInterval(timer);
      clearInterval(heartbeat);
      try {
        await reading;
        await read();
        pending += decoder.end();
        if (pending.trim()) report(pending);
      } finally { await file.close(); }
    },
  };
}
