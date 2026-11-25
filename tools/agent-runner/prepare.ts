// Reuse only preparation completed by this script for the same inputs and outputs.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Run = (args: string[]) => void;
export function prepare(root: string, run: Run = args => execFileSync('npm', args, { cwd: root, stdio: 'inherit' })): void {
  const stamp = join(root, 'node_modules/.agent-prepare.json');
  let previous: Record<string, string> = {};
  try { previous = JSON.parse(readFileSync(stamp, 'utf8')); } catch { /* no trusted record */ }
  const hash = (paths: string[]): string => {
    const h = createHash('sha256');
    const visit = (path: string): void => {
      if (path === 'node_modules/.agent-prepare.json' || path === 'node_modules/.vite') return;
      h.update(path + '\0');
      const full = join(root, path);
      if (!existsSync(full)) { h.update('missing'); return; }
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) h.update(readlinkSync(full));
      else if (stat.isDirectory()) {
        for (const name of readdirSync(full).sort()) visit(`${path}/${name}`);
      } else h.update(readFileSync(full));
    };
    for (const path of paths) visit(path);
    return h.digest('hex');
  };
  const config = JSON.parse(readFileSync(join(root, 'tools/servers.json'), 'utf8'));
  const sources = (): string[] => execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const steps: { name: string; args: string[]; inputs: () => string[]; outputs: string[] }[] = [
    { name: 'npm', args: ['ci'], inputs: () => ['package-lock.json', 'package.json', ...sources().filter(p => /^packages\/[^/]+\/package\.json$/.test(p))], outputs: ['node_modules/.package-lock.json', 'node_modules'] },
    { name: 'servers', args: ['run', 'setup:servers'], inputs: () => ['tools/servers.json', 'tools/setup-servers.ts'], outputs: [`servers/jre/.installed`, `servers/jre/bin/java`, `servers/java-${config.java.version}/server.jar`, `servers/java-${config.java.version}/eula.txt`, `servers/reports-${config.java.version}/reports`, `servers/bedrock-${config.bedrock.version}/bedrock_server`, `servers/tools/chunker-cli-${config.chunker.version}.jar`] },
    { name: 'mappings', args: ['run', 'setup:mappings'], inputs: () => ['tools/servers.json', ...sources().filter(p => p.startsWith('packages/converter/') || p === 'tools/setup-mappings.ts'), `servers/reports-${config.java.version}/reports/blocks.json`], outputs: ['servers/mappings'] },
    { name: 'pack', args: ['run', 'build:pack'], inputs: sources, outputs: ['packages/runtime-host/pack/scripts', 'packages/bridge-pack/pack/scripts', ...['launcher', 'tick-order', 'dynamic-properties', 'repeat-performance', 'repeat-density', 'runtime-queue'].map(p => `poc/${p}/pack/scripts`)] },
  ];
  for (const step of steps) {
    const fingerprint = (): string => hash([...step.inputs(), ...step.outputs]);
    if (step.outputs.every(p => existsSync(join(root, p))) && previous[step.name] === fingerprint()) {
      console.log(`prepared: ${step.name}`);
      continue;
    }
    // Invalidate the record before running: interruption or failure must not look successful.
    delete previous[step.name];
    if (existsSync(join(root, 'node_modules'))) writeFileSync(stamp, JSON.stringify(previous));
    run(step.args);
    if (!step.outputs.every(p => existsSync(join(root, p)))) throw new Error(`Missing ${step.name} output`);
    previous[step.name] = fingerprint();
    writeFileSync(stamp, JSON.stringify(previous));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) prepare(process.cwd());
