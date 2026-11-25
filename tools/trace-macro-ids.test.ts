import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('counts an ID hole separately from an NBT hole and emits only aggregates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'macro-ids-'));
  try {
    const grammar = { type: 'root', children: { give: { type: 'literal', children: { item: { type: 'argument', parser: 'minecraft:item_stack', executable: true } } } } };
    const rows = [
      { scope: 'private-world', function: 'secret:fn', cmd: '$give $(id)' },
      { scope: 'private-world', function: 'secret:fn', cmd: '$give stone{foo:$(value)}' },
      { scope: 'private-world', function: null, cmd: 'function secret:fn with storage secret:store args' },
      { scope: 'private-world', function: null, cmd: 'data modify storage secret:store args.id set value "stone"' },
    ];
    writeFileSync(join(dir, 'grammar.json'), JSON.stringify(grammar));
    writeFileSync(join(dir, 'private.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    const output = execFileSync(process.execPath, ['tools/trace-macro-ids.ts', join(dir, 'private.jsonl'), join(dir, 'grammar.json')], { encoding: 'utf8' });
    expect(output).not.toContain('secret');
    expect(JSON.parse(output)).toMatchObject({ macroLines: 2, holes: 2, idHoles: 1, matchingWrite: 1, literalCandidate: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
