// Java版サーバーの起動・操作。毎回新しいワールドで起動する。
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "./paths.ts";
import { ServerProcess } from "./process.ts";
import { Rcon } from "./rcon.ts";
import { DirLock, freeTcpPort } from "./resources.ts";

export interface JavaStartOptions {
  /** ワールドの datapacks/ にコピーするデータパックのディレクトリ */
  datapacks?: string[];
  /** 既存ワールドを使う場合のディレクトリ（コピーして使う） */
  world?: string;
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

  private constructor(proc: ServerProcess, rcon: Rcon, lock: DirLock) {
    this.proc = proc;
    this.rcon = rcon;
    this.lock = lock;
  }

  static async start(opts: JavaStartOptions = {}): Promise<JavaServer> {
    const lock = new DirLock(paths.javaServer);
    lock.acquire();
    try {
      const { proc, rcon } = await JavaServer.launch(opts);
      return new JavaServer(proc, rcon, lock);
    } catch (e) {
      lock.release();
      throw e;
    }
  }

  private static async launch(opts: JavaStartOptions): Promise<{ proc: ServerProcess; rcon: Rcon }> {
    const dir = paths.javaServer;
    const rconPort = opts.rconPort ?? (await freeTcpPort());
    const serverPort = await freeTcpPort();
    const worldDir = join(dir, LEVEL);
    rmSync(worldDir, { recursive: true, force: true });
    if (opts.world) cpSync(opts.world, worldDir, { recursive: true });
    for (const dp of opts.datapacks ?? []) {
      mkdirSync(join(worldDir, "datapacks"), { recursive: true });
      cpSync(dp, join(worldDir, "datapacks", basename(dp)), { recursive: true });
    }
    writeFileSync(
      join(dir, "server.properties"),
      [
        `level-name=${LEVEL}`,
        "level-type=minecraft\\:flat",
        "generate-structures=false",
        "online-mode=false",
        `server-port=${serverPort}`,
        "spawn-protection=0",
        "view-distance=4",
        "simulation-distance=4",
        "spawn-monsters=false",
        "enable-rcon=true",
        `rcon.password=${PASSWORD}`,
        `rcon.port=${rconPort}`,
        "broadcast-rcon-to-ops=false",
        "function-permission-level=2",
        "",
      ].join("\n"),
    );
    const proc = new ServerProcess(paths.java, [`-Xmx${opts.memory ?? "1G"}`, "-jar", "server.jar", "nogui"], {
      cwd: dir,
      logFile: join(paths.servers, "java-last.log"),
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

  /** コマンドを実行し、フィードバック文字列を返す。先頭の `/` は不要。 */
  exec(command: string): Promise<string> {
    return this.rcon.exec(command);
  }

  get log(): readonly string[] {
    return this.proc.lines;
  }

  async stop(): Promise<void> {
    try {
      await this.rcon.exec("stop");
    } catch {
      // 停止時に接続が切れることがある
    }
    this.rcon.close();
    const timer = setTimeout(() => this.proc.kill(), 30_000);
    await this.proc.exited;
    clearTimeout(timer);
    this.lock.release();
  }
}
