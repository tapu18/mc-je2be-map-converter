import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { failedChecks } from './policy.ts';
import type { Issue, PullRequest } from './policy.ts';

export function agentArguments(agent: 'codex' | 'claude', extra: string[]): string[] {
  if (agent === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', ...extra];
  const explicitSandbox = extra.some(arg => arg === '-s' || arg.startsWith('-s=') || arg === '--sandbox' || arg.startsWith('--sandbox='));
  const automatic = extra.includes('--approve-for-me');
  const bypass = extra.includes('--dangerously-bypass-approvals-and-sandbox');
  if (automatic && (explicitSandbox || bypass)) throw new Error('--approve-for-me cannot be combined with --sandbox or sandbox bypass');
  // --approve-for-me selects workspace-write itself; Clap rejects an explicit --sandbox.
  return ['exec', ...(!automatic && !bypass && !explicitSandbox ? ['--sandbox', 'workspace-write'] : []), '--json', ...extra, '-'];
}

export class AgentLaunchError extends Error {}

// Validate worker options before acquiring the runner lock or spending a budget.
export function validateWorkerArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== '--model' && !arg.startsWith('--model=')) continue;
    const value = arg === '--model' ? args[++i] : arg.slice('--model='.length);
    if (!value || value !== value.trim() || /^[\"']|[\"']$/.test(value) || value.startsWith('-')) {
      throw new AgentLaunchError('Invalid --model value in agentArgs: remove surrounding whitespace or quotes and provide a model name.');
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
      if (event.type === 'turn.failed' || event.type === 'error') failed = true;
      if (event.type === 'item.completed' && ['command_execution', 'file_change', 'mcp_tool_call'].includes(event.item?.type)) worked = true;
      if (event.type === 'assistant' && event.message?.content?.some((block: { type: string }) => block.type === 'tool_use')) worked = true;
    } catch { /* CLI diagnostics can be plain text. */ }
  }
  return failed && !worked;
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
