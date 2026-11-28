// `npm run agents` entry point. Runs tools/agent-runner.ts with the same arguments and
// starts it again when it exits with RESTART_EXIT_CODE after fast-forwarding its own code.
// Changes to this file itself take effect only after the owner restarts `npm run agents`.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RESTART_EXIT_CODE, SUPERVISED_ENV } from './self-update.ts';

const runner = fileURLToPath(new URL('../agent-runner.ts', import.meta.url));
const args = process.argv.slice(2);
let stopping = false;
let child: ReturnType<typeof spawn> | undefined;
// Ctrl+C reaches the child through the shared process group; SIGTERM / SIGHUP are forwarded.
process.on('SIGINT', () => { stopping = true; });
for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { stopping = true; child?.kill('SIGTERM'); });

for (;;) {
  const started = spawn(process.execPath, [runner, ...args], { stdio: 'inherit', env: { ...process.env, [SUPERVISED_ENV]: '1' } });
  child = started;
  const code = await new Promise<number>(resolve => started.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0))));
  if (code !== RESTART_EXIT_CODE || stopping) { process.exitCode = code === RESTART_EXIT_CODE ? 0 : code; break; }
  console.log(`${new Date().toISOString()} 管理プログラムを新しいコードで起動し直します`);
}
