// 変換器の CLI。
// 使い方: node packages/converter/src/cli.ts extract <Javaワールドのディレクトリ> [--summary] [--no-entities] [--blocks <blocks.json>]
// --blocks を省くと、servers/reports-*/reports/blocks.json（npm run setup:servers で作る）を探す
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBlockDefaults } from "./block-defaults.ts";
import { extractWorld } from "./extract.ts";

const [cmd, dir, ...flags] = process.argv.slice(2);
if (cmd !== "extract" || !dir) {
  console.error("usage: node packages/converter/src/cli.ts extract <world-dir> [--summary] [--no-entities]");
  process.exit(2);
}
function findBlocksJson(): string | undefined {
  const i = flags.indexOf("--blocks");
  if (i >= 0) return flags[i + 1];
  const servers = join(dirname(fileURLToPath(import.meta.url)), "../../../servers");
  if (!existsSync(servers)) return undefined;
  const dir = readdirSync(servers).filter((n) => n.startsWith("reports-")).sort().pop();
  const p = dir ? join(servers, dir, "reports", "blocks.json") : undefined;
  return p && existsSync(p) ? p : undefined;
}
const blocks = findBlocksJson();
if (!blocks) console.error("warning: blocks.json がない。既定値の状態が省かれたブロックの向きが取れない（npm run setup:servers で作る）");
const x = extractWorld(dir, { entities: !flags.includes("--no-entities"), ...(blocks ? { blockDefaults: loadBlockDefaults(blocks) } : {}) });
if (flags.includes("--summary")) {
  const kinds: Record<string, number> = {};
  for (const c of x.commandBlocks) kinds[c.kind ?? "unknown"] = (kinds[c.kind ?? "unknown"] ?? 0) + 1;
  const lengths: Record<string, number> = {};
  for (const ch of x.chains) {
    const k = ch.length >= 11 ? "11+" : ch.length >= 4 ? "4-10" : ch.length >= 2 ? "2-3" : "1";
    lengths[k] = (lengths[k] ?? 0) + 1;
  }
  console.log(JSON.stringify({
    dataVersion: x.dataVersion,
    dimensions: x.dimensions,
    commandBlocks: x.commandBlocks.length,
    kinds,
    chains: x.chains.length,
    chainLengths: lengths,
    orphanChainBlocks: x.orphanChainBlocks.length,
    objectives: x.scores.length,
    storage: Object.keys(x.storage).length,
    entities: x.entities.length,
  }, null, 2));
} else {
  console.log(JSON.stringify(x, null, 2));
}
