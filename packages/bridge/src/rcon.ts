// Source RCONプロトコルの最小実装（Java版サーバーへのコマンド送信用）。
//
// Java版サーバー（26.3で確認）の RCON には次の癖がある。
// - 1回の受信で届いた複数のパケットは先頭しか処理せず、続きは捨てて接続を切ることがある。
//   そのためコマンドは1つずつ、前の応答を受け取ってから送る。
// - 長い応答は 4096 文字ごとのパケットに分けて送る。終わりの印はない。
//   ちょうど 4096 文字の断片が来たら続きを待ち、短い断片で終わりとみなす。
//   全体が 4096 の倍数の長さだと続きが来ないため、短い待ち時間で打ち切る。
// - 受信バッファが 1460 バイトしかなく、それより長いパケット（コマンド本文 1446 バイト超）を送ると接続を切る。
import { connect, type Socket } from "node:net";

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const FRAGMENT = 4096;
const FRAGMENT_WAIT_MS = 300;
/** サーバーが受け取れるコマンド本文の最大バイト数（1460 - ヘッダ10 - 終端2 - 長さ4） */
export const RCON_MAX_COMMAND_BYTES = 1446;

interface Pending {
  id: number;
  text: string;
  resolve: (body: string) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class Rcon {
  private socket: Socket | undefined;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private current: Pending | undefined;
  /** 直列に送るための待ち行列（前のコマンドの完了を待つ） */
  private queue: Promise<unknown> = Promise.resolve();
  private closed: Error | undefined;

  async connect(host: string, port: number, password: string): Promise<void> {
    const socket = connect({ host, port });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    // 接続が切れたら、待っている要求を止まらせずに失敗させる
    socket.on("close", () => {
      this.closed = new Error("rcon connection closed");
      const cur = this.current;
      this.current = undefined;
      if (cur) {
        if (cur.timer) clearTimeout(cur.timer);
        cur.reject(this.closed);
      }
    });
    await this.request(TYPE_AUTH, password);
  }

  /** コマンドを実行し、サーバーが返したフィードバック文字列を返す。同時に呼んでも順に送る。 */
  exec(command: string): Promise<string> {
    return this.request(TYPE_EXEC, command);
  }

  close(): void {
    this.socket?.end();
    this.socket = undefined;
  }

  private request(type: number, body: string): Promise<string> {
    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        if (this.closed) return reject(this.closed);
        const bytes = Buffer.byteLength(body, "utf8");
        if (bytes > RCON_MAX_COMMAND_BYTES) {
          return reject(new Error(`rcon command too long: ${bytes} bytes (max ${RCON_MAX_COMMAND_BYTES})`));
        }
        const id = this.nextId++;
        this.current = { id, text: "", resolve, reject };
        this.send(id, type, body);
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private send(id: number, type: number, body: string): void {
    const payload = Buffer.from(body, "utf8");
    const packet = Buffer.alloc(14 + payload.length);
    packet.writeInt32LE(10 + payload.length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12);
    if (!this.socket) throw new Error("rcon not connected");
    this.socket.write(packet);
  }

  private finish(): void {
    const cur = this.current;
    if (!cur) return;
    if (cur.timer) clearTimeout(cur.timer);
    this.current = undefined;
    cur.resolve(cur.text);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (this.buffer.length < 4 + len) return;
      const id = this.buffer.readInt32LE(4);
      const body = this.buffer.subarray(12, 4 + len - 2).toString("utf8");
      this.buffer = this.buffer.subarray(4 + len);
      if (id === -1) throw new Error("rcon authentication failed");
      const cur = this.current;
      if (!cur || cur.id !== id) continue;
      cur.text += body;
      if (cur.timer) clearTimeout(cur.timer);
      if (body.length === FRAGMENT) cur.timer = setTimeout(() => this.finish(), FRAGMENT_WAIT_MS);
      else this.finish();
    }
  }
}
