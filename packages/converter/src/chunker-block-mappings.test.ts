import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { MappingLookup, type MappingTables } from "@je2be/core";
import { fluidPredicateRows, terrainCommandMappings } from "./chunker-block-mappings.ts";
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

it("matches fluid conditions by the still ID while placement keeps the flowing ID", () => {
  const water = (level: number, id: string) => ({
    java: { id: "minecraft:water", states: { level: String(level) } },
    bedrock: { id, states: { liquid_depth: level } },
  });
  const blocks = [water(0, "minecraft:water"), ...[1, 2, 8].map(level => water(level, "minecraft:flowing_water"))];
  const tables: MappingTables = { schemaVersion: 1, source: GEYSER_SOURCE, blocks, items: [] };
  const rows = fluidPredicateRows(blocks);
  expect(rows.map(row => row.bedrock.id)).toEqual(["minecraft:water", "minecraft:water", "minecraft:water"]);
  const mappings = new MappingLookup(tables, { predicateBlocks: rows });

  expect(mappings.block("minecraft:water", { level: "2" })).toMatchObject({ target: { id: "minecraft:flowing_water", states: { liquid_depth: 2 } } });
  expect(mappings.blockPredicate("minecraft:water", { level: "2" })).toMatchObject({ status: "mapped", target: { id: "minecraft:water", states: { liquid_depth: 2 } } });
  expect(mappings.blockPredicate("minecraft:water")).toMatchObject({ status: "mapped", target: { id: "minecraft:water", states: {} } });
  expect(new MappingLookup(tables).blockPredicate("minecraft:water")).toEqual({ status: "inexact", reason: "multiple-ids" });
});
