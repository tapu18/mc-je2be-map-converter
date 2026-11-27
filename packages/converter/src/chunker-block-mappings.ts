import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { blockStateKey, MappingLookup, type BlockMapping, type MappingTables } from "@je2be/core";
import overrides from "./chunker-block-overrides.json" with { type: "json" };

// #111 の実測を #323 で検証した組み合わせ。版を上げるときは再計測する。
const measured = {
  format: "BEDROCK_R26_60",
  chunkerSha256: "63148e587f5ee5a2ca7ebae1079b235c82ae4d1eff8f7a8a8a3398332513dda6",
  geyserRevision: "e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7",
  geyserBlocksSha256: "efc9305b53fc170dd153eb417e003a61f2b17f924592892726ecffc3dce58536",
  javaBlocksSha256: "7a0de8aaf7b04d00c40b8ffdc4cfe75184cff2e821d336a020573201867105a4",
};
const primary = new Map(overrides.map(row => [blockStateKey(row.java), row.bedrock]));

export function terrainCommandMappings(tables: MappingTables, chunkerJar: string, format: string): MappingLookup {
  const { source } = tables;
  if (format !== measured.format || source.revision !== measured.geyserRevision
    || source.sha256["blocks.nbt"] !== measured.geyserBlocksSha256
    || source.sha256["java-blocks.json"] !== measured.javaBlocksSha256
    || createHash("sha256").update(readFileSync(chunkerJar)).digest("hex") !== measured.chunkerSha256) {
    return new MappingLookup(tables);
  }
  const blocks = tables.blocks.map(row => {
    const bedrock = primary.get(blockStateKey(row.java));
    return bedrock ? { java: row.java, bedrock } : row;
  });
  return new MappingLookup({ ...tables, blocks }, { predicateBlocks: fluidPredicateRows(tables.blocks) });
}

/**
 * 水・溶岩の条件だけ、流水（`flowing_*`）を静止の ID に置き換えた行（#340）。
 * BDS 1.26.66.1 では、Chunker の地形も `setblock` で置いた `flowing_*` も、条件と Script API に
 * `water` / `lava` と `liquid_depth` で見える。配置は Geyser の `flowing_*` のまま（置いた後に流体が更新される）。
 */
export function fluidPredicateRows(blocks: readonly BlockMapping[]): BlockMapping[] {
  return blocks.flatMap(row => {
    const name = { "minecraft:water": "water", "minecraft:lava": "lava" }[row.java.id];
    if (!name || row.bedrock.id !== `minecraft:flowing_${name}`) return [];
    return [{ java: row.java, bedrock: { id: `minecraft:${name}`, states: row.bedrock.states } }];
  });
}
