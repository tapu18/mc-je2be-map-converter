// 検証用のJava版サーバー、BDS、Java実行環境を servers/ に取得する。
// 実行すると Minecraft EULA（https://aka.ms/MinecraftEULA）に同意したものとして eula.txt を書く。
// 使い方: npm run setup:servers
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface ServersConfig {
  jre: { name: string; url: string; sha256: string };
  java: { version: string; url: string; sha1: string };
  bedrock: { version: string; url: string };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "tools/servers.json"), "utf8")) as ServersConfig;
const serversDir = join(root, "servers");
const cacheDir = join(serversDir, ".download");

async function download(url: string, dest: string, hash?: { algo: "sha1" | "sha256"; value: string }): Promise<void> {
  if (existsSync(dest)) return;
  console.log(`download ${url}`);
  // minecraft.net はUser-Agentなしの要求を拒否することがある
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (hash) {
    const actual = createHash(hash.algo).update(buf).digest("hex");
    if (actual !== hash.value) throw new Error(`${url}: ${hash.algo} mismatch (${actual})`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
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
  await download(config.java.url, join(javaDir, "server.jar"), { algo: "sha1", value: config.java.sha1 });
  writeFileSync(join(javaDir, "eula.txt"), "eula=true\n");

  const bdsDir = join(serversDir, `bedrock-${config.bedrock.version}`);
  if (!existsSync(join(bdsDir, "bedrock_server"))) {
    const archive = join(cacheDir, `bedrock-server-${config.bedrock.version}.zip`);
    await download(config.bedrock.url, archive);
    extract(archive, bdsDir, "zip");
  }

  console.log(`ok: ${jreDir}\nok: ${javaDir}\nok: ${bdsDir}`);
}

await main();
