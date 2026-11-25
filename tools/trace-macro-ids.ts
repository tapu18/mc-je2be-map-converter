// Private input only. Output is aggregate counts; never print command text or identifiers.
// This is a finite probe, not a proof of fixed syntax or complete candidate sets.
import { readFileSync } from 'node:fs';
import { CommandParser, probeMacroTemplate, type CommandTreeNode } from '@je2be/core';

type Row = { scope: string; function: string | null; cmd: string };
const [input, grammar] = process.argv.slice(2);
if (!input || !grammar) throw new Error('usage: node tools/trace-macro-ids.ts <private JSONL> <commands.json>');
const rows = readFileSync(input, 'utf8').trim().split('\n').map(s => JSON.parse(s) as Row);
const parser = new CommandParser(JSON.parse(readFileSync(grammar, 'utf8')) as CommandTreeNode, { textFormat: 'snbt' });
const calls = new Map<string, string[]>();
const writes = new Map<string, string[]>();
for (const row of rows) {
  // Includes commands under execute; tags, macro-generated commands and relative IDs remain unresolved.
  for (const m of row.cmd.matchAll(/\bfunction\s+([a-z0-9_.-]+:[a-z0-9_./-]+)\s+with\s+storage\s+([^\s]+)\s+([^\s]+)/g)) {
    const key = `${row.scope}\0${m[1]}`;
    calls.set(key, [...(calls.get(key) ?? []), `${m[2]}\0${m[3]}`]);
  }
  for (const m of row.cmd.matchAll(/\bdata\s+(?:modify|merge|remove)\s+storage\s+([^\s]+)\s+(.+)/g)) {
    const key = `${row.scope}\0${m[1]}`;
    writes.set(key, [...(writes.get(key) ?? []), m[2]!]);
  }
}
const counts: Record<string, number> = { macroLines: 0, holes: 0, probeFailed: 0, idHoles: 0, noStorageCall: 0, noMatchingWrite: 0, matchingWrite: 0, literalCandidate: 0 };
for (const row of rows) {
  const cmd = row.cmd.trim();
  if (!cmd.startsWith('$')) continue;
  counts.macroLines!++;
  counts.holes! += [...cmd.matchAll(/\$\(([^()]+)\)/g)].length;
  const result = ['minecraft:stone', 'x', '0', '@s', '0 0 0', '{}'].map(v => probeMacroTemplate(parser, cmd, v)).find(Boolean);
  if (!result) { counts.probeFailed!++; continue; }
  for (const hole of result.holes) {
    if (!['minecraft:item_stack', 'minecraft:item_predicate', 'minecraft:block_state', 'minecraft:block_predicate'].includes(hole.parser)) continue;
    // A hole after the opening component/state/NBT syntax does not occupy the ID.
    if (/[\[{]/.test(cmd.slice(hole.start - hole.offset, hole.start))) continue;
    counts.idHoles!++;
    const sources = calls.get(`${row.scope}\0${row.function}`) ?? [];
    if (!sources.length) { counts.noStorageCall!++; continue; }
    const related = sources.some(source => {
      const [storage, path] = source.split('\0');
      return (writes.get(`${row.scope}\0${storage}`) ?? []).some(write => write.startsWith(path! + '.') || write.startsWith(path! + ' ') || write.startsWith(path! + '[') || write.startsWith('{'));
    });
    if (related) counts.matchingWrite!++; else counts.noMatchingWrite!++;
    // Only direct scalar set-value writes to the exact argument field are recognized.
    // This establishes a candidate, never a complete set of runtime values.
    const literal = sources.some(source => {
      const [storage, path] = source.split('\0');
      const field = `${path}.${hole.name} set value `;
      return (writes.get(`${row.scope}\0${storage}`) ?? []).some(write => {
        if (!write.startsWith(field)) return false;
        const value = write.slice(field.length).trim();
        return /^(?:"[a-z0-9_.:/-]+"|'[a-z0-9_.:/-]+'|[a-z0-9_.:/-]+)$/.test(value);
      });
    });
    if (literal) counts.literalCandidate!++;
  }
}
console.log(JSON.stringify(counts, null, 2));
