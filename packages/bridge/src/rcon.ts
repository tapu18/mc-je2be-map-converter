// Source RCONプロトコルの最小実装（Java版サーバーへのコマンド送信用）。
import { connect, type Socket } from "node:net";

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;

export class Rcon {
  private socket: Socket | undefined;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private waiters = new Map<number, (body: string) => void>();

  async connect(host: string, port: number, password: string): Promise<void> {
    const socket = connect({ host, port });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    const id = this.nextId++;
    const res = this.wait(id);
    this.send(id, TYPE_AUTH, password);
    await res;
  }

  /** コマンドを実行し、サーバーが返したフィードバック文字列を返す。 */
  async exec(command: string): Promise<string> {
    const id = this.nextId++;
    const res = this.wait(id);
    this.send(id, TYPE_EXEC, command);
    return res;
  }

  close(): void {
    this.socket?.end();
    this.socket = undefined;
  }

  private wait(id: number): Promise<string> {
    return new Promise((resolve) => this.waiters.set(id, resolve));
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

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (this.buffer.length < 4 + len) return;
      const id = this.buffer.readInt32LE(4);
      const body = this.buffer.subarray(12, 4 + len - 2).toString("utf8");
      this.buffer = this.buffer.subarray(4 + len);
      if (id === -1) throw new Error("rcon authentication failed");
      const w = this.waiters.get(id);
      if (w) {
        this.waiters.delete(id);
        w(body);
      }
    }
  }
}
