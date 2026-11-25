import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, it } from 'vitest';
import { prepare } from './prepare.ts';

it('reuses completed preparation and reruns changed or missing stages', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-prepare-'));
  const put = (path: string, value = 'ok') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  try {
    execFileSync('git', ['init', '-q', root]);
    put('package.json', '{}'); put('package-lock.json', '{}');
    const config = { java: { version: '1' }, bedrock: { version: '2' }, chunker: { version: '3' } };
    put('tools/servers.json', JSON.stringify(config));
    const outputs: Record<string, string[]> = {
      ci: ['node_modules/.package-lock.json'],
      'setup:servers': ['servers/jre/.installed', 'servers/jre/bin/java', 'servers/java-1/server.jar', 'servers/java-1/eula.txt', 'servers/reports-1/reports/blocks.json', 'servers/bedrock-2/bedrock_server', 'servers/tools/chunker-cli-3.jar'],
      'setup:mappings': ['servers/mappings/mappings.json'],
      'build:pack': ['packages/runtime-host/pack/scripts/main.js', 'packages/bridge-pack/pack/scripts/main.js', ...['launcher', 'tick-order', 'dynamic-properties', 'repeat-performance', 'repeat-density', 'runtime-queue'].map(p => `poc/${p}/pack/scripts/main.js`)],
    };
    put('.gitignore', 'node_modules/\nservers/\n**/pack/scripts/\n');
    const calls: string[] = [];
    const run = (args: string[]) => { const name = args.at(-1)!; calls.push(name); for (const path of outputs[name]!) put(path); };
    prepare(root, run);
    expect(calls).toEqual(['ci', 'setup:servers', 'setup:mappings', 'build:pack']);
    calls.length = 0;
    prepare(root, run);
    expect(calls).toEqual([]);
    rmSync(join(root, 'servers/bedrock-2/bedrock_server'));
    prepare(root, run);
    expect(calls).toContain('setup:servers');
    calls.length = 0;
    put('tools/servers.json', JSON.stringify({ ...config, bedrock: { version: '4' } }));
    outputs['setup:servers']!.push('servers/bedrock-4/bedrock_server');
    prepare(root, run);
    expect(calls).toContain('setup:servers');
    calls.length = 0;
    put('package-lock.json', '{"changed":true}');
    prepare(root, run);
    expect(calls).toContain('ci');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
