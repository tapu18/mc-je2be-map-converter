// BDSの起動・操作。検証パック（packages/bridge-pack）を経由して結果を受け取る。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nbt, readBedrockLevelDat, writeBedrockLevelDat, type NbtTag } from "@je2be/core";
import { paths } from "./paths.ts";
import { ServerProcess } from "./process.ts";
import { DirLock, freeUdpPort } from "./resources.ts";

export interface BedrockStartOptions {
  /** 追加で読み込むビヘイビアーパックのディレクトリ（manifest.json を含む） */
  behaviorPacks?: string[];
  /** 既存ワールドを使う場合のディレクトリ（コピーして使う） */
  world?: string;
  /** ベータAPIを有効にするか（既定: true） */
  betaApis?: boolean;
  /** チャンクを読み込ませておく範囲（x, z の最小・最大）。既定は 0..63 */
  tickingArea?: [number, number, number, number];
}

export interface BedrockResponse<T = unknown> {
  id: number;
  ok: boolean;
  result?: T;
  error?: string;
}

const LEVEL = "je2be-test";
const TEMPLATE = "je2be-template";

interface Manifest {
  header: { uuid: string; version: number[] };
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

async function writeProperties(dir: string, level: string): Promise<void> {
  const file = join(dir, "server.properties");
  let text = readFileSync(file, "utf8");
  const set = (key: string, value: string): void => {
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text}\n${key}=${value}`;
  };
  set("level-name", level);
  set("allow-cheats", "true");
  set("online-mode", "false");
  set("allow-list", "false");
  set("enable-lan-visibility", "false");
  set("content-log-console-output-enabled", "true");
  set("content-log-level", "info");
  // 同じマシンで複数のBDSを動かせるよう、毎回空きポートを使う
  set("server-port", String(await freeUdpPort("udp4")));
  set("server-portv6", String(await freeUdpPort("udp6").catch(() => freeUdpPort("udp4"))));
  writeFileSync(file, text);
}

export class BedrockServer {
  private nextId = 1;
  private pending = new Map<number, (res: BedrockResponse) => void>();
  private parts = new Map<number, string[]>();
  private readonly proc: ServerProcess;
  private readonly lock: DirLock;

  private constructor(proc: ServerProcess, lock: DirLock) {
    this.proc = proc;
    this.lock = lock;
    proc.onLine((line) => this.onLine(line));
  }

  /** 平坦ワールドの雛形を一度だけ作る（BDSは起動時にしかワールドを生成しないため）。 */
  private static async ensureTemplate(): Promise<string> {
    const dir = paths.bedrockServer;
    const template = join(dir, "worlds", TEMPLATE);
    if (existsSync(join(template, "level.dat"))) return template;
    await writeProperties(dir, TEMPLATE);
    const proc = new ServerProcess("./bedrock_server", [], {
      cwd: dir,
      env: { LD_LIBRARY_PATH: "." },
      logFile: join(paths.servers, "bedrock-template.log"),
    });
    await proc.waitFor((l) => l.includes("Server started"), 120_000, "bedrock template start");
    proc.write("stop");
    await proc.exited;
    // 生成済みチャンクを捨て、平坦ワールドとして作り直させる
    rmSync(join(template, "db"), { recursive: true, force: true });
    const datPath = join(template, "level.dat");
    const dat = readBedrockLevelDat(new Uint8Array(readFileSync(datPath)));
    dat.root.tag.value.set("Generator", nbt.int(2));
    writeFileSync(datPath, writeBedrockLevelDat(dat));
    return template;
  }

  static async start(opts: BedrockStartOptions = {}): Promise<BedrockServer> {
    const lock = new DirLock(paths.bedrockServer);
    lock.acquire();
    try {
      return await BedrockServer.launch(opts, lock);
    } catch (e) {
      lock.release();
      throw e;
    }
  }

  private static async launch(opts: BedrockStartOptions, lock: DirLock): Promise<BedrockServer> {
    const dir = paths.bedrockServer;
    const base = opts.world ?? (await BedrockServer.ensureTemplate());
    const worldDir = join(dir, "worlds", LEVEL);
    rmSync(worldDir, { recursive: true, force: true });
    cpSync(base, worldDir, { recursive: true });

    // ビヘイビアーパックをワールドに入れる
    const packs = [paths.bridgePack, ...(opts.behaviorPacks ?? [])];
    for (const p of packs) {
      const m = JSON.parse(readFileSync(join(p, "manifest.json"), "utf8")) as { modules?: { type: string; entry?: string }[] };
      const entry = m.modules?.find((mod) => mod.type === "script")?.entry;
      if (entry && !existsSync(join(p, entry))) {
        throw new Error(`${join(p, entry)} がありません。先に npm run build:pack を実行してください`);
      }
    }
    const packsDir = join(worldDir, "behavior_packs");
    mkdirSync(packsDir, { recursive: true });
    const refs = packs.map((p) => {
      const m = readManifest(p);
      // ディレクトリ名は "pack" などで重なり得るため、UUIDで置く
      cpSync(p, join(packsDir, m.header.uuid), { recursive: true });
      return { pack_id: m.header.uuid, version: m.header.version };
    });
    writeFileSync(join(worldDir, "world_behavior_packs.json"), JSON.stringify(refs, null, 2));

    // ベータAPIとコマンドの許可
    const datPath = join(worldDir, "level.dat");
    const dat = readBedrockLevelDat(new Uint8Array(readFileSync(datPath)));
    const root = dat.root.tag.value;
    const exp = new Map<string, NbtTag>();
    const beta = opts.betaApis ?? true;
    exp.set("gametest", nbt.byte(beta ? 1 : 0));
    exp.set("experiments_ever_used", nbt.byte(beta ? 1 : 0));
    exp.set("saved_with_toggled_experiments", nbt.byte(beta ? 1 : 0));
    root.set("experiments", nbt.compound(exp));
    root.set("cheatsEnabled", nbt.byte(1));
    root.set("commandsEnabled", nbt.byte(1));
    root.set("commandblocksenabled", nbt.byte(1));
    writeFileSync(datPath, writeBedrockLevelDat(dat));

    await writeProperties(dir, LEVEL);
    const proc = new ServerProcess("./bedrock_server", [], {
      cwd: dir,
      env: { LD_LIBRARY_PATH: "." },
      logFile: join(paths.servers, "bedrock-last.log"),
    });
    const server = new BedrockServer(proc, lock);
    try {
      await proc.waitFor((l) => l.includes("Server started"), 120_000, "bedrock server start");
      await proc.waitFor((l) => l.includes("JE2BE_READY"), 60_000, "bridge pack ready");

      const [x0, z0, x1, z1] = opts.tickingArea ?? [0, 0, 63, 63];
      proc.write(`tickingarea add ${x0} 0 ${z0} ${x1} 0 ${z1} je2be`);
      const deadline = Date.now() + 60_000;
      while (!(await server.request<boolean>("loaded", { pos: [x0, 0, z0] })).result) {
        if (Date.now() > deadline) throw new Error("ticking area did not load");
        await new Promise((r) => setTimeout(r, 250));
      }
      return server;
    } catch (e) {
      proc.kill();
      throw e;
    }
  }

  /** 検証パックに要求を送る。 */
  request<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<BedrockResponse<T>> {
    const id = this.nextId++;
    const line = `scriptevent je2be:req ${JSON.stringify({ id, op, ...args })}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${op}`)); }, timeoutMs);
      this.pending.set(id, (res) => { clearTimeout(timer); resolve(res as BedrockResponse<T>); });
      this.proc.write(line);
    });
  }

  /** パック経由でコマンドを実行し、成功数を返す。失敗時は error に理由が入る。 */
  exec(command: string, dimension = "overworld"): Promise<BedrockResponse<{ successCount: number }>> {
    return this.request("cmd", { cmd: command, dimension });
  }

  /** サーバーコンソールに直接コマンドを送る（応答は log から読む）。 */
  console(command: string): void {
    this.proc.write(command);
  }

  get log(): readonly string[] {
    return this.proc.lines;
  }

  async stop(): Promise<void> {
    this.proc.write("stop");
    const timer = setTimeout(() => this.proc.kill(), 30_000);
    await this.proc.exited;
    clearTimeout(timer);
    this.lock.release();
  }

  private onLine(line: string): void {
    const res = line.indexOf("JE2BE_RES ");
    if (res >= 0) {
      this.resolve(JSON.parse(line.slice(res + "JE2BE_RES ".length)) as BedrockResponse);
      return;
    }
    const part = line.indexOf("JE2BE_PART ");
    if (part >= 0) {
      const m = /^JE2BE_PART (\d+) (\d+) (\d+) (.*)$/.exec(line.slice(part));
      if (!m) return;
      const [, id, i, total, text] = m;
      const arr = this.parts.get(Number(id)) ?? [];
      arr[Number(i)] = text!;
      this.parts.set(Number(id), arr);
      if (arr.filter((s) => s !== undefined).length === Number(total)) {
        this.parts.delete(Number(id));
        this.resolve(JSON.parse(arr.join("")) as BedrockResponse);
      }
    }
  }

  private resolve(res: BedrockResponse): void {
    const w = this.pending.get(res.id);
    if (w) {
      this.pending.delete(res.id);
      w(res);
    }
  }
}
