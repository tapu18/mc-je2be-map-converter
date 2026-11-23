// 所有者の判断の受付を表示・更新する。docs/roles.md の「判断の受付」。
//   npm run decisions             一覧を標準出力に出す
//   npm run decisions -- --update ピン留めの受付 Issue（ラベル owner-inbox）の本文を書き換える
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { boardLabel, buildBoard } from './decisions-board.ts';
import type { BoardIssue } from './decisions-board.ts';

const { values } = parseArgs({ options: { update: { type: 'boolean', default: false } } });

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const open = JSON.parse(gh(['issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,body,labels'])) as BoardIssue[];
const body = buildBoard(open, new Date().toISOString().replace(/\.\d+Z$/, 'Z'));

if (!values.update) {
  process.stdout.write(body);
} else {
  const boards = open.filter(issue => issue.labels.some(label => label.name === boardLabel));
  if (boards.length !== 1) {
    console.error(`ラベル ${boardLabel} の開いている Issue が ${boards.length} 件あります。1件にしてください（docs/roles.md）。`);
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'je2be-decisions-'));
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, body);
    gh(['issue', 'edit', String(boards[0]!.number), '--body-file', file]);
    console.log(`#${boards[0]!.number} を更新しました`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
