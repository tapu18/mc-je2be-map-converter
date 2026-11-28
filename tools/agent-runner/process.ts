import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

export class CommandError extends Error {
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null) { super(message); this.exitCode = exitCode; }
}

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: string;
  input?: string;
  /** Called with the process group id once the child is spawned. */
  onSpawn?: (pid: number) => void;
}

// One process group per invocation: timeout / shutdown also stops servers and shells.
export async function command(executable: string, args: string[], options: CommandOptions): Promise<string> {
  const file = options.log ? await open(options.log, 'a+', 0o600) : undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error('Stopping')); return; }
      const child = spawn(executable, args, {
        cwd: options.cwd, detached: true,
        stdio: ['pipe', file ? file.fd : 'pipe', file ? file.fd : 'pipe'],
      });
      if (child.pid) options.onSpawn?.(child.pid);
      let stdout = '';
      let stderr = '';
      let stopped = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 5000);
      };
      const timer = setTimeout(stop, options.timeoutMs ?? 60_000);
      options.signal?.addEventListener('abort', stop, { once: true });
      const clean = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', stop);
        // Descendants may survive their parent exiting, including on a normal exit.
        kill('SIGKILL');
      };
      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
      child.once('error', error => { clean(); reject(error); });
      child.once('exit', () => { kill('SIGKILL'); });
      child.once('close', (code, signal) => {
        clean();
        if (stopped || code !== 0) reject(new CommandError(`${executable}: ${stopped ? 'stopped / timed out' : `exit ${code ?? signal}`} ${stderr}`, stopped ? null : code));
        else resolve(stdout);
      });
      child.stdin?.on('error', () => { /* Early CLI exit may close stdin. */ });
      child.stdin?.end(options.input);
    });
  } catch (error) {
    if (file && error instanceof Error) {
      const size = (await file.stat()).size;
      const tail = Buffer.alloc(Math.min(size, 8000));
      await file.read(tail, 0, tail.length, Math.max(0, size - tail.length));
      error.message += `\nlog: ${options.log}\n${tail.toString('utf8')}`;
    }
    throw error;
  } finally { await file?.close(); }
}
