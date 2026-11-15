// 検証用のJava版サーバー、BDS、Java実行環境を servers/ に取得する。
// 実行すると Minecraft EULA（https://aka.ms/MinecraftEULA）に同意したものとして eula.txt を書く。
// 使い方: npm run setup:servers
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface ServersConfig {
  jre: { name: string; url: string; sha256: string };
  java: { version: string; url: string; sha1: string };
  bedrock: { version: string; url: string };
  chunker: { version: string; url: string; sha256: string };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "tools/servers.json"), "utf8")) as ServersConfig;
const serversDir = join(root, "servers");
// ダウンロードしたアーカイブは worktree をまたいで共有する
const cacheDir = process.env.JE2BE_DOWNLOAD_CACHE ?? join(homedir(), ".cache", "je2be");

/** 一時的なネットワーク障害（CIでのタイムアウトなど）に備えて数回やり直す。 */
async function fetchWithRetry(url: string, attempts = 4): Promise<Buffer> {
  for (let i = 1; ; i++) {
    try {
      // minecraft.net はUser-Agentなしの要求を拒否することがある
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)" } });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= attempts) throw e;
      const wait = 2000 * 2 ** (i - 1);
      console.log(`retry ${i}/${attempts - 1} in ${wait}ms: ${e instanceof Error ? e.message : String(e)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function download(url: string, dest: string, hash?: { algo: "sha1" | "sha256"; value: string }): Promise<void> {
  if (existsSync(dest)) return;
  console.log(`download ${url}`);
  const buf = await fetchWithRetry(url);
  if (hash) {
    const actual = createHash(hash.algo).update(buf).digest("hex");
    if (actual !== hash.value) throw new Error(`${url}: ${hash.algo} mismatch (${actual})`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  // 複数のworktreeから同時に取得しても壊れたファイルを残さないよう、書き終えてから置き換える
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
}

function extract(archive: string, destDir: string, kind: "tar" | "zip"): void {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  if (kind === "tar") execFileSync("tar", ["-xzf", archive, "-C", destDir, "--strip-components=1"]);
  else execFileSync("unzip", ["-q", archive, "-d", destDir]);
}

async function main(): Promise<void> {
  mkdirSync(cacheDir, { recursive: true });

  const jreDir = join(serversDir, "jre");
  const jreStamp = join(jreDir, ".installed");
  if (!existsSync(jreStamp) || readFileSync(jreStamp, "utf8") !== config.jre.name) {
    const archive = join(cacheDir, `${config.jre.name}.tar.gz`);
    await download(config.jre.url, archive, { algo: "sha256", value: config.jre.sha256 });
    extract(archive, jreDir, "tar");
    writeFileSync(jreStamp, config.jre.name);
  }

  const javaDir = join(serversDir, `java-${config.java.version}`);
  const jar = join(cacheDir, `server-${config.java.version}.jar`);
  await download(config.java.url, jar, { algo: "sha1", value: config.java.sha1 });
  mkdirSync(javaDir, { recursive: true });
  if (!existsSync(join(javaDir, "server.jar"))) copyFileSync(jar, join(javaDir, "server.jar"));
  writeFileSync(join(javaDir, "eula.txt"), "eula=true\n");

  const bdsDir = join(serversDir, `bedrock-${config.bedrock.version}`);
  if (!existsSync(join(bdsDir, "bedrock_server"))) {
    const archive = join(cacheDir, `bedrock-server-${config.bedrock.version}.zip`);
    await download(config.bedrock.url, archive);
    extract(archive, bdsDir, "zip");
  }

  // 地形変換器 Chunker の CLI（第三者製。取得は所有者が許可済み、#6）
  const chunkerJar = join(serversDir, "tools", `chunker-cli-${config.chunker.version}.jar`);
  const chunkerCache = join(cacheDir, `chunker-cli-${config.chunker.version}.jar`);
  await download(config.chunker.url, chunkerCache, { algo: "sha256", value: config.chunker.sha256 });
  mkdirSync(dirname(chunkerJar), { recursive: true });
  if (!existsSync(chunkerJar)) copyFileSync(chunkerCache, chunkerJar);

  console.log(`ok: ${jreDir}\nok: ${javaDir}\nok: ${bdsDir}\nok: ${chunkerJar}`);
}

await main();
