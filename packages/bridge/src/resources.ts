// 複数のエージェントが同じマシンでサーバーを起動しても衝突しないための小道具。
import { createSocket } from "node:dgram";
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** 空いているTCPポートを1つ返す。 */
export function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

/** 空いているUDPポートを1つ返す。 */
export function freeUdpPort(type: "udp4" | "udp6" = "udp4"): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createSocket(type);
    sock.once("error", reject);
    sock.bind(0, () => {
      const { port } = sock.address();
      sock.close(() => resolve(port));
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * サーバーディレクトリの排他ロック。同じディレクトリのサーバーを二重に起動しようとしたら例外を投げる。
 * 持ち主のプロセスが終了済みのロックは取り直す。
 */
export class DirLock {
  private readonly file: string;
  private held = false;

  constructor(dir: string) {
    this.file = join(dir, ".je2be.lock");
  }

  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.file, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        this.held = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const owner = Number(readFileSync(this.file, "utf8"));
        if (Number.isInteger(owner) && owner > 0 && alive(owner)) {
          throw new Error(
            `${this.file} は別のプロセス（pid ${owner}）が使用中です。同じ servers/ を共有せず、worktree ごとに npm run setup:servers してください`,
          );
        }
        rmSync(this.file, { force: true });
      }
    }
    throw new Error(`could not acquire ${this.file}`);
  }

  release(): void {
    if (!this.held) return;
    rmSync(this.file, { force: true });
    this.held = false;
  }
}
