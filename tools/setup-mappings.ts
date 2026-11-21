// 承認済み Geyser 対応表を固定取得し、出典・MIT 許諾文と一緒に正規化する。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fetchGeyserSources, generateGeyserMappings, GEYSER_SOURCE } from "@je2be/converter";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  "source-dir": { type: "string" }, blocks: { type: "string" }, out: { type: "string" }, offline: { type: "boolean", default: false },
} });
const source = resolve(values["source-dir"] ?? join(root, "servers", "geyser-source"));
const report = resolve(values.blocks ?? join(root, "servers", `reports-${GEYSER_SOURCE.javaVersion}`, "reports", "blocks.json"));
const output = resolve(values.out ?? join(root, "servers", "mappings"));
if (!values.offline) await fetchGeyserSources(source);
const tables = generateGeyserMappings(source, report, output);
console.log(JSON.stringify({ output, source: tables.source, blocks: tables.blocks.length, items: tables.items.length, sounds: Object.keys(tables.sounds ?? {}).length, particles: Object.keys(tables.particles ?? {}).length }, null, 2));
