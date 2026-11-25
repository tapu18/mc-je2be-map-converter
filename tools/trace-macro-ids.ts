// Private input only. Output is aggregate counts; never print command text or identifiers.
// This is a finite probe, not a proof of fixed syntax or complete candidate sets.
import { readFileSync } from 'node:fs';
import { CommandParser, probeMacroTemplate, type CommandTreeNode } from '@je2be/core';
import { parseSnbt } from '../packages/core/src/command/snbt.ts';

type Row = { scope: string; function: string | null; cmd: string };
const [input, grammar] = process.argv.slice(2);
if (!input || !grammar) throw new Error('usage: node tools/trace-macro-ids.ts <private JSONL> <commands.json>');
const rows = readFileSync(input, 'utf8').trim().split('\n').map(s => JSON.parse(s) as Row);
const parser = new CommandParser(JSON.parse(readFileSync(grammar, 'utf8')) as CommandTreeNode, { textFormat: 'snbt' });
const calls = new Map<string, string[]>();
const writes = new Map<string, string[]>();
const invocations = new Map<string, Set<string>>();
const resource = (id: string) => id.includes(':') ? id : `minecraft:${id}`;
for (const row of rows) {
  // Function tags and macro-generated names remain unresolved.
  for (const m of row.cmd.matchAll(/\bfunction\s+([a-z0-9_./-]+(?::[a-z0-9_./-]+)?)((?:\s+[^\s]+)?)/g)) {
    const id = resource(m[1]!);
    const key = `${row.scope}\0${id}`;
    const kinds = invocations.get(key) ?? new Set<string>();
    const next = m[2]!.trim();
    if (next === 'with') {
      const rest = row.cmd.slice(m.index! + m[0].length);
      const source = /^\s+(storage|entity|block)\b/.exec(rest)?.[1] ?? 'unknown';
      kinds.add(`with-${source}`);
    } else kinds.add(next.startsWith('{') ? 'inline' : 'other');
    invocations.set(key, kinds);
  }
  // Includes commands under execute; tags, macro-generated commands and relative IDs remain unresolved.
  for (const m of row.cmd.matchAll(/\bfunction\s+([a-z0-9_./-]+(?::[a-z0-9_./-]+)?)\s+with\s+storage\s+([^\s]+)(?:\s+([^\s]+))?/g)) {
    const id = resource(m[1]!);
    const key = `${row.scope}\0${id}`;
    calls.set(key, [...(calls.get(key) ?? []), `${resource(m[2]!)}\0${m[3] ?? ""}`]);
  }
  for (const m of row.cmd.matchAll(/\bdata\s+(?:modify|merge|remove)\s+storage\s+([^\s]+)\s+(.+)/g)) {
    const key = `${row.scope}\0${resource(m[1]!)}`;
    writes.set(key, [...(writes.get(key) ?? []), m[2]!]);
  }
}
// Try mixed substitutions on failed rows. A successful parse may leave some holes in
// literals; retain mapped arguments without claiming the remaining holes are classified.
function mixedProbe(cmd: string) {
  const holes = [...cmd.matchAll(/\$\(([^()]+)\)/g)];
  const names = [...new Set(holes.map(h => h[1]!))];
  const values = ['minecraft:stone', 'x', '0', '@s', '0 0 0', '{}'];
  const mapped: { name: string; start: number; end: number; argument: string; parser: string; offset: number }[] = [];
  let parsed = false;
  for (let attempt = 0; attempt < Math.min(6 ** names.length, 512); attempt++) {
    let n = attempt, concrete = '', cursor = 1;
    const replacements = names.map(() => { const value = values[n % values.length]!; n = Math.floor(n / values.length); return value; });
    const positions = holes.map(h => {
      const start = h.index;
      concrete += cmd.slice(cursor, start);
      const concreteStart = concrete.length;
      concrete += replacements[names.indexOf(h[1]!)]!;
      cursor = start + h[0].length;
      return { h, concreteStart, concreteEnd: concrete.length };
    });
    concrete += cmd.slice(cursor);
    const result = parser.parse(concrete);
    if (!result.ok) continue;
    parsed = true;
    for (const { h, concreteStart, concreteEnd } of positions) {
      const node = result.nodes.find(node => node.kind === 'argument' && node.start <= concreteStart && node.end >= concreteEnd);
      if (node?.parser) mapped.push({ name: h[1]!, start: h.index, end: h.index + h[0].length, argument: node.name, parser: node.parser, offset: concreteStart - node.start });
    }
  }
  return { parsed, holes: mapped };
}
const counts: Record<string, number> = { macroLines: 0, holes: 0, probeFailed: 0, mixedParsed: 0, mixedUnmappedHoles: 0, idHoles: 0, differingHoleTypes: 0, noStorageCall: 0, noMatchingWrite: 0, matchingWrite: 0, literalCandidate: 0, mergeCandidate: 0, compoundSetCandidate: 0, candidateAny: 0, unresolvedNoCall: 0, unresolvedNoWrites: 0, unresolvedWrites: 0, storageHasMerge: 0, storageHasSetValue: 0, storageHasOtherWrite: 0, noDirectInvocation: 0, otherInvocation: 0, inlineInvocation: 0, withStorageInvocation: 0, withEntityInvocation: 0, withBlockInvocation: 0, withUnknownInvocation: 0, bareOrOtherInvocation: 0 };
for (const row of rows) {
  const cmd = row.cmd.trim();
  if (!cmd.startsWith('$')) continue;
  counts.macroLines!++;
  counts.holes! += [...cmd.matchAll(/\$\(([^()]+)\)/g)].length;
  const results = ['minecraft:stone', 'x', '0', '@s', '0 0 0', '{}'].map(v => probeMacroTemplate(parser, cmd, v)).filter(r => r !== undefined);
  if (!results.length) {
    const mixed = mixedProbe(cmd);
    if (!mixed.parsed) { counts.probeFailed!++; continue; }
    counts.mixedParsed!++;
    counts.mixedUnmappedHoles! += [...cmd.matchAll(/\$\(([^()]+)\)/g)].length - new Set(mixed.holes.map(h => h.start)).size;
    results.push({ nodes: [], holes: mixed.holes });
  }
  const byPosition = new Map<number, typeof results[number]['holes']>();
  for (const result of results) for (const hole of result.holes) {
    const found = byPosition.get(hole.start) ?? [];
    found.push(hole);
    byPosition.set(hole.start, found);
  }
  for (const variants of byPosition.values()) {
    if (new Set(variants.map(h => h.parser)).size > 1) counts.differingHoleTypes!++;
    // A hole after the opening component/state/NBT syntax does not occupy the ID.
    const hole = variants.find(h => ['minecraft:item_stack', 'minecraft:item_predicate', 'minecraft:block_state', 'minecraft:block_predicate'].includes(h.parser) && !/[\[{]/.test(cmd.slice(h.start - h.offset, h.start)));
    if (!hole) continue;
    counts.idHoles!++;
    const sources = calls.get(`${row.scope}\0${row.function}`) ?? [];
    if (!sources.length) {
      counts.noStorageCall!++;
      counts.unresolvedNoCall!++;
      const kinds = invocations.get(`${row.scope}\0${row.function}`);
      if (kinds) {
        counts.otherInvocation!++;
        if (kinds.has('inline')) counts.inlineInvocation!++;
        if (kinds.has('with-storage')) counts.withStorageInvocation!++;
        if (kinds.has('with-entity')) counts.withEntityInvocation!++;
        if (kinds.has('with-block')) counts.withBlockInvocation!++;
        if (kinds.has('with-unknown')) counts.withUnknownInvocation!++;
        if (kinds.has('other')) counts.bareOrOtherInvocation!++;
      } else counts.noDirectInvocation!++;
      continue;
    }
    const allWrites = sources.flatMap(source => {
      const [storage] = source.split('\0');
      return writes.get(`${row.scope}\0${storage}`) ?? [];
    });
    if (allWrites.some(write => write.startsWith('{'))) counts.storageHasMerge!++;
    if (allWrites.some(write => /\bset value\b/.test(write))) counts.storageHasSetValue!++;
    if (allWrites.some(write => !write.startsWith('{') && !/\bset value\b/.test(write))) counts.storageHasOtherWrite!++;
    const related = sources.some(source => {
      const [storage, path] = source.split('\0');
      return (writes.get(`${row.scope}\0${storage}`) ?? []).some(write => write.startsWith(path! + '.') || write.startsWith(path! + ' ') || write.startsWith(path! + '[') || write.startsWith('{'));
    });
    if (related) counts.matchingWrite!++; else counts.noMatchingWrite!++;
    // Only direct scalar set-value writes to the exact argument field are recognized.
    // This establishes a candidate, never a complete set of runtime values.
    const literal = sources.some(source => {
      const [storage, path] = source.split('\0');
      const field = `${path ? path + '.' : ''}${hole.name} set value `;
      return (writes.get(`${row.scope}\0${storage}`) ?? []).some(write => {
        if (!write.startsWith(field)) return false;
        const value = write.slice(field.length).trim();
        try {
          const tag = parseSnbt(value);
          return tag.type === 'string' && /^[a-z0-9_.:/-]+$/.test(tag.value);
        } catch { return false; }
      });
    });
    if (literal) counts.literalCandidate!++;
    const merged = sources.some(source => {
      const [storage, path] = source.split('\0');
      const keys = [...(path ? path.split('.') : []), hole.name];
      if (keys.some(key => !/^[a-zA-Z0-9_+-]+$/.test(key))) return false;
      return (writes.get(`${row.scope}\0${storage}`) ?? []).some(write => {
        if (!write.startsWith('{')) return false;
        try {
          let tag = parseSnbt(write);
          for (const key of keys) {
            if (tag.type !== 'compound') return false;
            const child = tag.value.get(key);
            if (!child) return false;
            tag = child;
          }
          return tag.type === 'string';
        } catch { return false; }
      });
    });
    if (merged) counts.mergeCandidate!++;
    // A set of an ancestor compound can supply the field as well.
    const compoundSet = sources.some(source => {
      const [storage, path] = source.split('\0');
      const keys = [...(path ? path.split('.') : []), hole.name];
      if (keys.some(key => !/^[a-zA-Z0-9_+-]+$/.test(key))) return false;
      return (writes.get(`${row.scope}\0${storage}`) ?? []).some(write => {
        const match = /^([^\s]+) set value (.+)$/.exec(write);
        if (!match) return false;
        const prefix = match[1]!.split('.');
        if (prefix.length >= keys.length || prefix.some((key, i) => key !== keys[i])) return false;
        try {
          let tag = parseSnbt(match[2]!);
          for (const key of keys.slice(prefix.length)) {
            if (tag.type !== 'compound') return false;
            const child = tag.value.get(key);
            if (!child) return false;
            tag = child;
          }
          return tag.type === 'string';
        } catch { return false; }
      });
    });
    if (compoundSet) counts.compoundSetCandidate!++;
    if (literal || merged || compoundSet) counts.candidateAny!++;
    else if (!allWrites.length) counts.unresolvedNoWrites!++;
    else counts.unresolvedWrites!++;
  }
}
console.log(JSON.stringify(counts, null, 2));
