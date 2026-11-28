// CI の使い捨て checkout でのみ実行する。公式配布情報を記録し、固定版の仮更新を行う。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { selectBedrockBeta } from "./version-canary-select.ts";
import { geyserSeriesMismatches } from "./version-series.ts";
import { GEYSER_SOURCE } from "../packages/converter/src/geyser-source.ts";

const out = "servers/version-canary";
mkdirSync(out, { recursive: true });
async function get(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { "User-Agent": "je2be-version-canary", Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}
async function json(url: string): Promise<any> { return (await get(url)).json(); }
const config = JSON.parse(readFileSync("tools/servers.json", "utf8"));
const previous = structuredClone(config);
const links = await json("https://net-secondary.web.minecraft-services.net/api/v1.0/download/links");
const bdsUrl = links.result.links.find((x: any) => x.downloadType === "serverBedrockLinux")?.downloadUrl as string | undefined;
const bdsVersion = bdsUrl?.match(/^https:\/\/www\.minecraft\.net\/bedrockdedicatedserver\/bin-linux\/bedrock-server-([\d.]+)\.zip$/)?.[1];
if (!bdsVersion) throw new Error("BDS Linux stable URL not found or unexpected");
config.bedrock = { version: bdsVersion, url: bdsUrl };
const manifest = await json("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
const entry = manifest.versions.find((x: any) => x.id === manifest.latest.release && x.type === "release");
if (!entry) throw new Error("Java release missing from manifest");
const javaMeta = await json(entry.url);
if (entry.id !== config.java.version) {
  const jar = Buffer.from(await (await get(javaMeta.downloads.server.url)).arrayBuffer());
  if (createHash("sha1").update(jar).digest("hex") !== javaMeta.downloads.server.sha1) throw new Error("Java server SHA-1 mismatch");
  const outer = `${out}/server.jar`;
  const inner = `${out}/inner.jar`;
  writeFileSync(outer, jar);
  const entries = execFileSync("unzip", ["-Z1", outer], { encoding: "utf8" }).split("\n").filter((x) => /^META-INF\/versions\/[^/]+\/[^/]+\.jar$/.test(x));
  if (entries.length !== 1) throw new Error("Java bundled server jar missing");
  writeFileSync(inner, execFileSync("unzip", ["-p", outer, entries[0]!], { maxBuffer: 128 * 1024 * 1024 }));
  const metadata = JSON.parse(execFileSync("unzip", ["-p", inner, "version.json"], { encoding: "utf8" }));
  if (metadata.id !== entry.id || !Number.isSafeInteger(metadata.world_version)) throw new Error("Java version.json mismatch");
  config.java = { version: entry.id, dataVersion: metadata.world_version, url: javaMeta.downloads.server.url, sha1: javaMeta.downloads.server.sha1 };
}
const release = await json("https://api.github.com/repos/HiveGamesOSS/Chunker/releases/latest");
const asset = release.assets.find((x: any) => x.name === `chunker-cli-${release.tag_name}.jar`);
if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error("Chunker CLI asset or SHA-256 missing");
config.chunker = { ...config.chunker, version: release.tag_name, url: asset.browser_download_url, sha256: asset.digest.slice(7) };
const pkgPath = "packages/bridge-pack/package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const npmVersions: Record<string, { previous: string; latestBeta: string; candidate: string }> = {};
for (const name of Object.keys(pkg.dependencies).filter((x) => x.startsWith("@minecraft/"))) {
  const registry = await json(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  // beta の dist-tag は preview を指すこともある。BDS と同じ stable 系列だけを使う。
  const tagged = registry["dist-tags"].beta as string;
  const candidate = selectBedrockBeta(Object.keys(registry.versions as object), bdsVersion, tagged);
  npmVersions[name] = { previous: pkg.dependencies[name], latestBeta: tagged, candidate };
  pkg.dependencies[name] = candidate;
}
// Geyser の対応表は自動で上げない。最新 revision と、使っているファイルの変化だけを記録する（#362）。
const geyserRepo = "GeyserMC/mappings";
const geyserBranch = (await json(`https://api.github.com/repos/${geyserRepo}`)).default_branch as string;
const geyserHead = await json(`https://api.github.com/repos/${geyserRepo}/commits/${encodeURIComponent(geyserBranch)}`);
const geyserLatest = geyserHead.sha as string;
if (!/^[a-f0-9]{40}$/.test(geyserLatest)) throw new Error("Geyser latest revision missing");
const geyserFiles: Record<string, { changed: boolean; pinnedSha256: string; latestSha256: string }> = {};
for (const name of ["blocks.nbt", "items.json", "sounds.json", "particles.json", "LICENSE"] as const) {
  // compare API のファイル一覧は 300 件で切れるため、内容のハッシュで比べる。
  const bytes = Buffer.from(await (await get(`https://raw.githubusercontent.com/${geyserRepo}/${geyserLatest}/${name}`)).arrayBuffer());
  const latestSha256 = createHash("sha256").update(bytes).digest("hex");
  geyserFiles[name] = { changed: latestSha256 !== GEYSER_SOURCE.sha256[name], pinnedSha256: GEYSER_SOURCE.sha256[name], latestSha256 };
}
const geyser = {
  pinned: { revision: GEYSER_SOURCE.revision, javaVersion: GEYSER_SOURCE.javaVersion, bedrockVersion: GEYSER_SOURCE.bedrockVersion },
  latest: { revision: geyserLatest, date: geyserHead.commit?.committer?.date as string | undefined, message: (geyserHead.commit?.message as string | undefined)?.split("\n", 1)[0] },
  revisionChanged: geyserLatest !== GEYSER_SOURCE.revision,
  usedFilesChanged: Object.values(geyserFiles).some((x) => x.changed),
  files: geyserFiles,
  // 候補版に対する系列のずれ。空でなければ npm run check も落ちる（tools/version-series.test.ts）。
  seriesMismatches: geyserSeriesMismatches(GEYSER_SOURCE, config),
};
writeFileSync(`${out}/versions.json`, JSON.stringify({ previous, candidate: config, npm: npmVersions, geyser }, null, 2) + "\n");
writeFileSync("tools/servers.json", JSON.stringify(config, null, 2) + "\n");
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
// manifest の API module version は npm の prerelease suffix を除いたもの。
const moduleVersion = pkg.dependencies["@minecraft/server"].match(/^(\d+\.\d+\.\d+-beta)/)?.[1];
if (!moduleVersion) throw new Error("unexpected @minecraft/server version");
for (const path of ["packages/bridge-pack/pack/manifest.json", "poc/launcher/pack/manifest.json", "poc/tick-order/pack/manifest.json", "poc/dynamic-properties/pack/manifest.json", "poc/repeat-performance/pack/manifest.json", "poc/repeat-density/pack/manifest.json", "poc/runtime-queue/pack/manifest.json"]) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const dep of manifest.dependencies ?? []) if (dep.module_name === "@minecraft/server") dep.version = moduleVersion;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}
console.log(JSON.stringify({ previous, candidate: config, npm: npmVersions, geyser }, null, 2));
