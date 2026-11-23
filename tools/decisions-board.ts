// 所有者の判断の受付（ピン留めの Issue）の本文を、開いている Issue から組み立てる。
// 役割と運用は docs/roles.md の「判断の受付」。
import { dependencies, hasLabel } from './agent-runner/policy.ts';

export interface BoardIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
}

export const approvalLabel = 'needs-approval';
export const ownerTaskLabel = 'owner-task';
export const boardLabel = 'owner-inbox';
export const boardTitle = '所有者の判断の受付';

interface Entry {
  issue: BoardIssue;
  question: string;
  recommendation: string | undefined;
  waitingOn: number[];
  blocks: number[];
}

// 見出しの直後の、最初の空でない行（箇条書きの記号は落とす）。
export function sectionFirstLine(body: string, heading: string): string | undefined {
  const lines = body.split('\n');
  const start = lines.findIndex(line => new RegExp(`^#{1,6}\\s+${heading}\\s*$`).test(line.trim()));
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) return undefined;
    const text = line.trim().replace(/^(?:[-*]|\d+\.)\s+/, '');
    if (text) return text;
  }
  return undefined;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function refs(numbers: number[], limit = 6): string {
  if (numbers.length === 0) return '—';
  const shown = numbers.slice(0, limit).map(n => `#${n}`).join(' ');
  return numbers.length > limit ? `${shown} ほか${numbers.length - limit}件` : shown;
}

export function buildBoard(open: BoardIssue[], generatedAt: string): string {
  const openNumbers = new Set(open.map(issue => issue.number));
  const blockedBy = new Map<number, number[]>();
  for (const issue of open) {
    for (const dep of dependencies(issue.body)) {
      if (!openNumbers.has(dep)) continue;
      blockedBy.set(dep, [...(blockedBy.get(dep) ?? []), issue.number]);
    }
  }
  const entry = (issue: BoardIssue): Entry => ({
    issue,
    question: sectionFirstLine(issue.body, '問い') ?? issue.title,
    recommendation: sectionFirstLine(issue.body, '推奨'),
    waitingOn: dependencies(issue.body).filter(dep => openNumbers.has(dep)),
    blocks: (blockedBy.get(issue.number) ?? []).sort((a, b) => a - b),
  });
  const decisions = open.filter(issue => hasLabel(issue, approvalLabel) && !hasLabel(issue, boardLabel)).map(entry);
  // 止めている Issue が多い順。同数なら古い順。
  const byImpact = (a: Entry, b: Entry) => b.blocks.length - a.blocks.length || a.issue.number - b.issue.number;
  const ready = decisions.filter(e => e.waitingOn.length === 0).sort(byImpact);
  const waiting = decisions.filter(e => e.waitingOn.length > 0).sort(byImpact);
  const tasks = open.filter(issue => hasLabel(issue, ownerTaskLabel) && !hasLabel(issue, boardLabel)).map(entry).sort(byImpact);

  const out: string[] = [
    '所有者が判断すること・すべきことの一覧です。PM が `npm run decisions -- --update` で更新します。手で編集しないでください。',
    '',
    '**答え方**：このIssueに `#番号: 答え` の形でコメントしてください（例：`#119: 案2。ただし…`）。自由な文章でも、チャットでも構いません。PM が判断のIssueに記録し、このコメントに「記録しました」と返信します。',
    '',
    `## 1. 判断できるもの（${ready.length}件）`,
    '',
    '材料がそろっていて、答えればすぐ作業が進むものです。止めている Issue が多い順に並べています。',
    '',
  ];
  if (ready.length === 0) out.push('なし');
  else {
    out.push('| Issue | 問い | PM の推奨 | 止めている Issue |', '| --- | --- | --- | --- |');
    for (const e of ready) out.push(`| #${e.issue.number} | ${cell(e.question)} | ${cell(e.recommendation ?? '（未記入）')} | ${refs(e.blocks)} |`);
  }
  out.push('', `## 2. 所有者の作業（${tasks.length}件）`, '', '実クライアントでのプレイ確認、作者への依頼など、所有者にしかできない作業です。', '');
  if (tasks.length === 0) out.push('なし');
  else {
    out.push('| Issue | 内容 | 待っているもの |', '| --- | --- | --- |');
    for (const e of tasks) out.push(`| #${e.issue.number} | ${cell(e.question)} | ${refs(e.waitingOn)} |`);
  }
  out.push('', `## 3. 調査待ち（${waiting.length}件）`, '', '判断はまだ要りません。調査が終わると 1 に移ります。', '');
  if (waiting.length === 0) out.push('なし');
  else {
    out.push('| Issue | 問い | 待っている調査 |', '| --- | --- | --- |');
    for (const e of waiting) out.push(`| #${e.issue.number} | ${cell(e.question)} | ${refs(e.waitingOn)} |`);
  }
  out.push('', `更新：${generatedAt}`);
  return out.join('\n') + '\n';
}
