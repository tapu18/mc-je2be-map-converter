import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

interface ServersConfig {
  java: { version: string };
  bedrock: { version: string };
}

const config = JSON.parse(readFileSync(join(repoRoot, "tools/servers.json"), "utf8")) as ServersConfig;

export const paths = {
  servers: join(repoRoot, "servers"),
  java: join(repoRoot, "servers", "jre", "bin", "java"),
  javaServer: join(repoRoot, "servers", `java-${config.java.version}`),
  bedrockServer: join(repoRoot, "servers", `bedrock-${config.bedrock.version}`),
  bridgePack: join(repoRoot, "packages", "bridge-pack", "pack"),
  /** データ生成の blocks.json（npm run setup:servers で作る） */
  blocksReport: join(repoRoot, "servers", `reports-${config.java.version}`, "reports", "blocks.json"),
};
