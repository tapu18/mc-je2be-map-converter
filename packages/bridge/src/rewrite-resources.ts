// コマンドの書き換え（#62）に使う文法・対応表の場所。対応表がなければ固定版を取得して作る（npm run setup:mappings と同じ）。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchGeyserSources, generateGeyserMappings, type RewriteResources } from "@je2be/converter";
import type { MappingTables } from "@je2be/core";
import { paths } from "./paths.ts";

export async function rewriteResources(): Promise<RewriteResources> {
  const tables = existsSync(paths.mappings) ? JSON.parse(readFileSync(paths.mappings, "utf8")) as MappingTables : undefined;
  if (!tables?.sounds || !tables.particles) {
    const source = join(paths.servers, "geyser-source");
    await fetchGeyserSources(source);
    generateGeyserMappings(source, paths.blocksReport, dirname(paths.mappings));
  }
  return { commandsJson: paths.commandsReport, blocksJson: paths.blocksReport, mappingsJson: paths.mappings };
}
