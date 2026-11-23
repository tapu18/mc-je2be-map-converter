import { describe, expect, it } from 'vitest';
import { buildBoard, sectionFirstLine } from './decisions-board.ts';
import type { BoardIssue } from './decisions-board.ts';

const issue = (number: number, labels: string[], body = '', title = `Issue ${number}`): BoardIssue =>
  ({ number, title, body, labels: labels.map(name => ({ name })) });

describe('decisions board', () => {
  it('reads the first line of a section and stops at the next heading', () => {
    const body = '## 問い\n\n- 範囲をどうするか\n\n## 推奨\n案2\n## 空\n\n## 次\nx';
    expect(sectionFirstLine(body, '問い')).toBe('範囲をどうするか');
    expect(sectionFirstLine(body, '推奨')).toBe('案2');
    expect(sectionFirstLine(body, '空')).toBeUndefined();
    expect(sectionFirstLine(body, 'なし')).toBeUndefined();
  });

  it('separates decidable decisions, owner tasks and decisions waiting on open research', () => {
    const board = buildBoard([
      issue(10, ['needs-approval'], '## 問い\nA にするか\n## 推奨\nA'),
      issue(11, ['needs-approval'], '## 問い\n調査待ちの問い\n\nDepends on: #20, #99'),
      issue(12, ['owner-task'], 'Depends on: #10', 'プレイ確認'),
      issue(20, ['status:ready']),
      issue(30, ['status:blocked'], 'Depends on: #10'),
      issue(31, ['status:blocked'], 'Depends on: #10, #11'),
      issue(40, ['owner-inbox', 'needs-approval']),
    ], '2026-11-23T00:00:00Z');
    const [ready, tasks, waiting] = board.split(/^## \d\. /m).slice(1);
    expect(ready).toContain('| #10 | A にするか | A | #12 #30 #31 |');
    expect(ready).not.toContain('#11 |');
    expect(tasks).toContain('| #12 | プレイ確認 | #10 |');
    // #99 は閉じている（一覧にない）ので待ちに数えない
    expect(waiting).toContain('| #11 | 調査待ちの問い | #20 |');
    expect(board).not.toContain('#40 |');
  });

  it('orders decisions by how many open issues they block and marks a missing recommendation', () => {
    const board = buildBoard([
      issue(1, ['needs-approval']),
      issue(2, ['needs-approval'], '', 'タイトル | 縦棒'),
      issue(3, [], 'Depends on: #2'),
    ], 'now');
    expect(board.indexOf('| #2 |')).toBeLessThan(board.indexOf('| #1 |'));
    expect(board).toContain('| #2 | タイトル \\| 縦棒 | （未記入） | #3 |');
  });
});
