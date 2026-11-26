import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { MappingTables } from "@je2be/core";
import { terrainCommandMappings } from "./chunker-block-mappings.ts";
import { GEYSER_SOURCE } from "./geyser-source.ts";

it("keeps the Geyser state when the terrain conversion does not match the audit", () => {
  const java = { id: "minecraft:beetroots", states: { age: "1" } };
  const bedrock = { id: "minecraft:beetroot", states: { growth: 3 } };
  const tables: MappingTables = { schemaVersion: 1, source: GEYSER_SOURCE, blocks: [{ java, bedrock }], items: [] };
  const otherJar = fileURLToPath(new URL("../package.json", import.meta.url));

  for (const mappings of [
    terrainCommandMappings(tables, otherJar, "BEDROCK_R26_60"),
    terrainCommandMappings(tables, "", "BEDROCK_R26_50"),
    terrainCommandMappings({ ...tables, source: { ...tables.source, revision: "other" } }, "", "BEDROCK_R26_60"),
  ]) {
    expect(mappings.block(java.id, java.states)).toMatchObject({ status: "mapped", target: bedrock });
  }
});
