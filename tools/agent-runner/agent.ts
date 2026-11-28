import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { failedChecks } from './policy.ts';
import type { Issue, PullRequest } from './policy.ts';

export class AgentLaunchError extends Error {}

export function agentArguments(agent: 'codex' | 'claude', extra: string[]): string[] {
  if (agent === 'claude') {
    // `claude -p` cannot ask for approval, so without a mode every tool call is refused.
    const grants = ['--permission-mode', '--allowedTools', '--allowed-tools'];
    if (!extra.some(arg => grants.some(flag => arg === flag || arg.startsWith(`${flag}=`)) || arg === '--dangerously-skip-permissions')) {
      throw new AgentLaunchError('Claude needs --permission-mode or --allowedTools in agentArgs: non-interactive runs cannot approve tools.');
    }
    return ['-p', '--output-format', 'stream-json', '--verbose', ...extra];
  }
  const explicitSandbox = extra.some(arg => arg === '-s' || arg.startsWith('-s=') || arg === '--sandbox' || arg.startsWith('--sandbox='));
  const automatic = extra.includes('--approve-for-me');
  const bypass = extra.includes('--dangerously-bypass-approvals-and-sandbox');
  if (automatic && (explicitSandbox || bypass)) throw new Error('--approve-for-me cannot be combined with --sandbox or sandbox bypass');
  // --approve-for-me selects workspace-write itself; Clap rejects an explicit --sandbox.
  return ['exec', ...(!automatic && !bypass && !explicitSandbox ? ['--sandbox', 'workspace-write'] : []), '--json', ...extra, '-'];
}


// Validate worker options before acquiring the runner lock or spending a budget.
export function validateWorkerArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = ['--model', '-m'].find(name => arg === name || arg.startsWith(`${name}=`));
    if (!flag) continue;
    const value = arg === flag ? args[++i] : arg.slice(flag.length + 1);
    if (!value || value !== value.trim() || /^[\"']|[\"']$/.test(value) || value.startsWith('-')) {
      throw new AgentLaunchError(`Invalid ${flag} value in agentArgs: remove surrounding whitespace or quotes and provide a model name.`);
    }
  }
}

// Only classify structured failures before observable work; incomplete or unparseable
// logs and interrupted processes remain ordinary failures to avoid refunding work.
export async function failedBeforeWork(logfile: string): Promise<boolean> {
  let failed = false;
  let worked = false;
  const lines = createInterface({ input: createReadStream(logfile), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.failed' || event.type === 'error' || (event.type === 'result' && event.is_error)) failed = true;
      if (event.type === 'item.completed' && ['command_execution', 'file_change', 'mcp_tool_call'].includes(event.item?.type)) worked = true;
      if (event.type === 'assistant' && event.message?.content?.some((block: { type: string }) => block.type === 'tool_use')) worked = true;
    } catch { /* CLI diagnostics can be plain text. */ }
  }
  return failed && !worked;
}

// Provider quota messages, e.g. Codex: "You’ve hit your usage limit ... try again at 2:21 PM."
// Claude: "Claude AI usage limit reached|<epoch seconds>", "You've hit your limit · resets 3pm"
// or "You've hit your 5-hour limit · resets 3:50am".
const limitPattern = /usage limit|hit your (?:[\w-]+ )?limit|limit reached|rate limit/i;

type LimitEvent = { message?: string; resetsAt?: number };

function limitEvent(line: string): LimitEvent | undefined {
  let event;
  try { event = JSON.parse(line); }
  catch { return limitPattern.test(line) ? { message: line.trim() } : undefined; } // CLI diagnostics on stderr.
  if (!event || typeof event !== 'object') return undefined;
  // Claude reports a refused request with its reset time before the failing result.
  if (event.type === 'rate_limit_event') {
    const info = event.rate_limit_info;
    return info?.status === 'rejected' && typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : undefined;
  }
  // Only the CLI's own failure events: tool output and agent text may mention limits harmlessly.
  const text = event.type === 'error' ? event.message
    : event.type === 'turn.failed' ? event.error?.message
    : event.type === 'result' && event.is_error ? event.result
    : undefined;
  if (typeof text !== 'string') return undefined;
  if (event.type === 'result' && (event.api_error === 'usage_limit_reached' || event.error === 'rate_limit')) return { message: text };
  return limitPattern.test(text) ? { message: text } : undefined;
}

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Parse the reset time a quota message names; local wall-clock times are the next occurrence. */
export function limitResetAt(message: string, now: number): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(message);
  if (epoch) return Number(epoch[1]) * 1000;
  // "try again at 2:21 PM", "resets 3pm", or with a date: "try again at Nov 30th, 2026 9:53 PM".
  const clock = /(?:try again at|resets(?: at)?)\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(message);
  if (!clock) return undefined;
  const month = clock[1] === undefined ? undefined : months.indexOf(clock[1].toLowerCase());
  if (month === -1) return undefined;
  let hour = Number(clock[4]);
  const minute = Number(clock[5] ?? 0);
  const meridiem = clock[6]?.[0]?.toLowerCase();
  if (meridiem === 'p' && hour < 12) hour += 12;
  if (meridiem === 'a' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const at = new Date(now);
  if (month !== undefined) {
    const day = Number(clock[2]);
    if (clock[3] !== undefined) at.setFullYear(Number(clock[3]), month, day);
    else {
      at.setMonth(month, day);
      at.setHours(hour, minute, 0, 0);
      if (at.getTime() <= now) at.setFullYear(at.getFullYear() + 1, month, day);
    }
    if (at.getMonth() !== month) return undefined; // e.g. Feb 31st
    at.setHours(hour, minute, 0, 0);
    return at.getTime();
  }
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** The last provider quota failure in a CLI log, if the run ended because of one. */
export async function usageLimit(logfile: string): Promise<string | undefined> {
  let found: string | undefined;
  let resetsAt: number | undefined;
  const lines = createInterface({ input: createReadStream(logfile), crlfDelay: Infinity });
  for await (const line of lines) {
    const event = limitEvent(line);
    if (event?.message !== undefined) found = event.message;
    if (event?.resetsAt !== undefined) resetsAt = event.resetsAt;
  }
  // A structured reset time is exact; the wall-clock text depends on this machine's time zone.
  if (found !== undefined && resetsAt !== undefined && !/\|\d{10}\b/.test(found)) found = `${found}|${resetsAt}`;
  return found;
}

export function workerPrompt({ task, item, repo, root, base, pr }: {
  task: { claim: string; issue: number; worktree: string; branch: string; attempts: number };
  item: Issue; repo: string; root: string; base: string; pr?: PullRequest | undefined;
}): string {
  const reasons: string[] = [];
  if (task.attempts > 1) reasons.push('前回の実行は完了条件を満たさず終了しました。残りの作業を続けてください。');
  if (pr?.mergeStateStatus === 'DIRTY') reasons.push(`PR #${pr.number} は競合しています。${base} を取り込んで競合を解き、CI を通してください。`);
  if (pr) {
    const failed = failedChecks(pr);
    if (failed.length) reasons.push(`PR #${pr.number} の失敗したチェック: ${failed.join('、')}。原因を調べて修正してください。`);
  }
  return [
        `あなたは ${task.claim}。${repo} の Issue #${task.issue} だけを作業してください。`,
        `既存の worktree ${task.worktree} とブランチ ${task.branch} を使ってください。着手済みです。`,
        '最初に CLAUDE.md と docs/workflow.md と Issue の本文・コメント、既存PRとCIを読んでください。',
        '再実行の場合があります。git status と履歴を確認し、未コミット変更や既存PRを引き継いでください。',
        ...reasons,
        '完了条件を満たすか、時間切れまで続けてください。区切りの記録は続けるための手段であり、終了する理由ではありません。',
        '依存の未完了や人の判断が必要なら、待つ Issue を本文に Depends on: #番号 で記載し、根拠と再開手順をコメントして status:blocked にしてください。判断の Issue には needs-approval を付けて終了してください。',
        'node tools/agent-runner/prepare.ts で準備を確認してください。準備済みの手順は省き、本題から始めます。未準備または入力が変わった手順は実行します。その後、実装・適切な検証・コミット・push・PR作成まで進めてください。',
        `配布マップの原本は ${join(root, 'sample-map')}（git管理外）にあります。必要なら読み取り用に参照し、原本を変更・GitHubへ公開しないでください。`,
        'PR本文に Closes #' + task.issue + ' を記載。既存PRがあれば修正してください。完了条件を検証できるまでdraftにしてください。',
        'npm run check と関連する実サーバーテストを通し、完了条件を満たしたらPRをreadyにしてください。CI失敗時は原因を調べて修正してください。',
        'マージとブランチ/worktree削除は管理プログラムが判断するので実行しないでください。Issueのclaimは変更しないでください。',
        '別のIssueには着手しないでください。新たな作業はIssueに記録してください。区切りごとに進捗と再開手順をIssueへ残してください。',
        '作業途中で終了するときは status:paused を付けず、進捗と再開手順を Issue に書いてください。次の巡回で同じ worktree から再実行し、起動回数を数えます。',
        '管理プログラムの設定・状態・ロックは変更しないでください。',
        `今回のIssueスナップショット（最新状態はghで確認）:\n${JSON.stringify(item)}`,
  ].join('\n');
}
