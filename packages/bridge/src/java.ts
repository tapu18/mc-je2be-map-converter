// Java版サーバーの起動・操作。毎回新しいワールドで起動する。
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "./paths.ts";
import { ServerProcess } from "./process.ts";
import { Rcon } from "./rcon.ts";
import { DirLock, freeTcpPort } from "./resources.ts";
import { dumpJavaWorld, type JavaDump, type JavaDumpRequest } from "./java-dump.ts";

export interface JavaStartOptions {
  /** 版別の検証サーバーを使う場合。省略時は tools/servers.json の固定版。 */
  runtime?: { java: string; serverDirectory: string };
  /** ワールドの datapacks/ にコピーするデータパックのディレクトリ */
  datapacks?: string[];
  /** 新規ワールドで有効にするパック ID の順序（例: vanilla, file/my-pack）。 */
  initialEnabledPacks?: string[];
  /** 既存ワールドを使う場合のディレクトリ（コピーして使う） */
  world?: string;
  /** シナリオでコマンドブロックを有効にする。 */
  enableCommandBlock?: boolean;
  memory?: string;
  /** 省略時は空きポートを使う */
  rconPort?: number;
  /** 常時読み込む範囲（x, z の最小・最大）。既定は 0..63 */
  forceload?: [number, number, number, number];
}

const PASSWORD = "je2be-local";
const LEVEL = "je2be-test";

export class JavaServer {
  private readonly proc: ServerProcess;
  private readonly rcon: Rcon;
  private readonly lock: DirLock;
  private readonly opts: JavaStartOptions;

  private constructor(proc: ServerProcess, rcon: Rcon, lock: DirLock, opts: JavaStartOptions) {
    this.proc = proc;
    this.rcon = rcon;
    this.lock = lock;
    this.opts = opts;
  }

  static async start(opts: JavaStartOptions = {}): Promise<JavaServer> {
    const lock = new DirLock(JavaServer.directory(opts));
    lock.acquire();
    try {
      JavaServer.prepareWorld(opts);
      const { proc, rcon } = await JavaServer.launch(opts);
      return new JavaServer(proc, rcon, lock, opts);
    } catch (e) {
      lock.release();
      throw e;
    }
  }

  private static directory(opts: JavaStartOptions): string { return opts.runtime?.serverDirectory ?? paths.javaServer; }

  get worldDirectory(): string { return join(JavaServer.directory(this.opts), LEVEL); }

  /** ワールドを作り直し、データパックを入れる。 */
  private static prepareWorld(opts: JavaStartOptions): void {
    const worldDir = join(JavaServer.directory(opts), LEVEL);
    rmSync(worldDir, { recursive: true, force: true });
    if (opts.world) cpSync(opts.world, worldDir, { recursive: true });
    for (const dp of opts.datapacks ?? []) {
      mkdirSync(join(worldDir, "datapacks"), { recursive: true });
      cpSync(dp, join(worldDir, "datapacks", basename(dp)), { recursive: true });
    }
  }

  private static async launch(opts: JavaStartOptions): Promise<{ proc: ServerProcess; rcon: Rcon }> {
    const dir = JavaServer.directory(opts);
    const rconPort = opts.rconPort ?? (await freeTcpPort());
    const serverPort = await freeTcpPort();
    writeFileSync(
      join(dir, "server.properties"),
      [
        `level-name=${LEVEL}`,
        "level-type=minecraft\\:flat",
        "generate-structures=false",
        "online-mode=false",
        `server-port=${serverPort}`,
        "spawn-protection=0",
        ...(opts.enableCommandBlock ? ["enable-command-block=true"] : []),
        "view-distance=4",
        "simulation-distance=4",
        "spawn-monsters=false",
        "enable-rcon=true",
        `rcon.password=${PASSWORD}`,
        `rcon.port=${rconPort}`,
        "broadcast-rcon-to-ops=false",
        "function-permission-level=2",
        ...(opts.initialEnabledPacks ? [`initial-enabled-packs=${opts.initialEnabledPacks.join(",")}`] : []),
        "",
      ].join("\n"),
    );
    const proc = new ServerProcess(opts.runtime?.java ?? paths.java, [`-Xmx${opts.memory ?? "1G"}`, "-jar", "server.jar", "nogui"], {
      cwd: dir,
      logFile: opts.runtime ? join(dir, "java-last.log") : join(paths.servers, "java-last.log"),
    });
    try {
      await proc.waitFor((l) => l.includes("RCON running on"), 180_000, "java server start");
      const rcon = new Rcon();
      await rcon.connect("127.0.0.1", rconPort, PASSWORD);

      // プレイヤーがいないとチャンクが読み込まれないため、BDS側のticking areaと同じ範囲を常時読み込む
      const [x0, z0, x1, z1] = opts.forceload ?? [0, 0, 63, 63];
      await rcon.exec(`forceload add ${x0} ${z0} ${x1} ${z1}`);
      const deadline = Date.now() + 60_000;
      while (!/Test passed/.test(await rcon.exec(`execute if loaded ${x0} 0 ${z0}`))) {
        if (Date.now() > deadline) throw new Error("forceloaded chunks did not load");
        await new Promise((r) => setTimeout(r, 250));
      }
      return { proc, rcon };
    } catch (e) {
      proc.kill();
      throw e;
    }
  }

  /**
   * ワールドを保存し（save-all flush）、保存データから状態を取り出す。
   * RCON の文字列出力では取れないブロックステート、エンティティ一覧、storage の型付きの値を得るため。
   */
  async dump(req: JavaDumpRequest): Promise<JavaDump> {
    const res = await this.rcon.exec("save-all flush");
    if (!/Saved the game/.test(res)) throw new Error(`save-all flush failed: ${res}`);
    return dumpJavaWorld(this.worldDirectory, req);
  }

  /** コマンドを実行し、フィードバック文字列を返す。先頭の `/` は不要。 */
  exec(command: string): Promise<string> {
    return this.rcon.exec(command);
  }

  get log(): readonly string[] {
    return this.proc.lines;
  }

  async stop(): Promise<void> {
    await this.shutdown();
    this.lock.release();
  }

  private async shutdown(): Promise<void> {
    try {
      await this.rcon.exec("stop");
    } catch {
      // 停止時に接続が切れることがある
    }
    this.rcon.close();
    const timer = setTimeout(() => this.proc.kill(), 30_000);
    await this.proc.exited;
    clearTimeout(timer);
  }

  /**
   * 同じワールドのまま再起動する（保存と復元の確認用）。戻り値の新しいインスタンスを使うこと。
   * このインスタンスはそれ以降使えない。
   */
  async restart(): Promise<JavaServer> {
    await this.shutdown();
    try {
      const { proc, rcon } = await JavaServer.launch(this.opts);
      return new JavaServer(proc, rcon, this.lock, this.opts);
    } catch (e) {
      this.lock.release();
      throw e;
    }
  }
}
