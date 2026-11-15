import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";

/** 標準出力を1行ずつ扱えるサーバープロセス。ログはファイルにも残す。 */
export class ServerProcess {
  readonly lines: string[] = [];
  private listeners = new Set<(line: string) => void>();
  private proc: ChildProcessWithoutNullStreams;
  private log: WriteStream;
  readonly exited: Promise<number | null>;

  constructor(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; logFile: string }) {
    this.log = createWriteStream(opts.logFile);
    this.proc = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: "pipe" });
    for (const stream of [this.proc.stdout, this.proc.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        this.log.write(line + "\n");
        this.lines.push(line);
        for (const l of this.listeners) l(line);
      });
    }
    this.exited = new Promise((resolve) => this.proc.on("exit", (code) => { this.log.end(); resolve(code); }));
  }

  onLine(fn: (line: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 条件に合う行が出るまで待つ。既に出ている行も対象にする。 */
  waitFor(pred: (line: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    const found = this.lines.find(pred);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${what}`)); }, timeoutMs);
      const off = this.onLine((line) => {
        if (pred(line)) { clearTimeout(timer); off(); resolve(line); }
      });
      void this.exited.then((code) => { clearTimeout(timer); off(); reject(new Error(`process exited (${code}) while waiting for ${what}`)); });
    });
  }

  write(line: string): void {
    this.proc.stdin.write(line + "\n");
  }

  kill(): void {
    this.proc.kill("SIGKILL");
  }
}
