import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { blockStateKey, MappingLookup, readNbt, type BlockMapping, type ItemMapping, type MappingTables, type NbtCompound } from "@je2be/core";
import { GEYSER_SOURCE } from "./geyser-source.ts";

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`expected object: ${context}`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^minecraft:[a-z0-9_./]+$/.test(value)) throw new Error(`invalid vanilla identifier: ${String(value)}`);
  return value;
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** NBT の配列位置は JE の状態 ID。Geyser BlockMappings / BlockEntry の固定版に従う。 */
export function normalizeGeyserMappings(root: NbtCompound, items: unknown, javaReport: unknown): Pick<MappingTables, "blocks" | "items"> {
  const list = root.value.get("bedrock_mappings");
  if (list?.type !== "list" || list.elementType !== "compound") throw new Error("missing bedrock_mappings list");
  const blocks: BlockMapping[] = [];
  const seen = new Set<number>();
  for (const [id, raw] of Object.entries(object(javaReport, "JE blocks report"))) {
    identifier(id);
    const report = object(raw, id);
    const properties = Object.keys(object(report.properties ?? {}, `${id} properties`)).sort();
    if (!Array.isArray(report.states) || report.states.length === 0) throw new Error(`missing states: ${id}`);
    for (const rawState of report.states) {
      const state = object(rawState, id);
      const index = state.id;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || seen.has(index)) throw new Error(`invalid/duplicate JE state ID: ${String(index)}`);
      seen.add(index);
      const entry = list.value[index];
      if (entry?.type !== "compound") throw new Error(`missing mapping for JE state ID: ${index}`);
      const javaStates: Record<string, string> = {};
      for (const [name, value] of Object.entries(object(state.properties ?? {}, `${id} state`))) {
        if (typeof value !== "string") throw new Error(`invalid JE property: ${id}.${name}`);
        javaStates[name] = value;
      }
      if (JSON.stringify(Object.keys(javaStates).sort()) !== JSON.stringify(properties)) throw new Error(`incomplete JE properties: ${id}`);
      const name = entry.value.get("bedrock_identifier");
      if (name && name.type !== "string") throw new Error(`invalid bedrock_identifier: ${index}`);
      const bedrockId = identifier(name ? (name.value.includes(":") ? name.value : `minecraft:${name.value}`) : id);
      const states = entry.value.get("state");
      if (states && states.type !== "compound") throw new Error(`invalid Bedrock states: ${index}`);
      const bedrockStates: Record<string, boolean | number | string> = {};
      if (states) {
        for (const [key, value] of states.value) {
          if (value.type === "byte" && (value.value === 0 || value.value === 1)) bedrockStates[key] = value.value === 1;
          else if (value.type === "int" || value.type === "string") bedrockStates[key] = value.value;
          else throw new Error(`unsupported Bedrock state type: ${index}.${key} (${value.type})`);
        }
      }
      blocks.push({ java: { id, states: sorted(javaStates) }, bedrock: { id: bedrockId, states: sorted(bedrockStates) } });
    }
  }
  if (seen.size !== list.value.length) throw new Error(`JE/Geyser state count mismatch: ${seen.size}/${list.value.length}`);
  const normalizedItems: ItemMapping[] = [];
  for (const [id, value] of Object.entries(object(items, "Geyser items"))) {
    const row = object(value, id);
    const data = row.bedrock_data;
    if (data !== undefined && (typeof data !== "number" || !Number.isSafeInteger(data) || data < 0)) throw new Error(`invalid item data: ${id}`);
    normalizedItems.push({ javaId: identifier(id), bedrockId: identifier(row.bedrock_identifier), ...(data === undefined ? {} : { data: data as number }) });
  }
  blocks.sort((a, b) => {
    const ka = blockStateKey(a.java), kb = blockStateKey(b.java);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  normalizedItems.sort((a, b) => a.javaId < b.javaId ? -1 : a.javaId > b.javaId ? 1 : 0);
  return { blocks, items: normalizedItems };
}

export function verifyMappingSource(name: keyof typeof GEYSER_SOURCE.sha256, bytes: Uint8Array): void {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== GEYSER_SOURCE.sha256[name]) throw new Error(`${name}: SHA-256 mismatch (expected ${GEYSER_SOURCE.sha256[name]}, got ${hash})`);
}

/** 固定された3ファイルのみを取得。既存ファイルも検証し、破損を黙って置き換えない。 */
export async function fetchGeyserSources(directory: string): Promise<void> {
  mkdirSync(directory, { recursive: true });
  for (const name of ["blocks.nbt", "items.json", "LICENSE"] as const) {
    const path = join(directory, name);
    if (existsSync(path)) {
      verifyMappingSource(name, readFileSync(path));
      continue;
    }
    const url = `https://raw.githubusercontent.com/GeyserMC/mappings/${GEYSER_SOURCE.revision}/${name}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verifyMappingSource(name, bytes);
    writeFileSync(path, bytes);
  }
}

/** 表の生成と許諾文の同梱。sourceDirectory を事前取得すればオフラインでも使える。 */
export function generateGeyserMappings(sourceDirectory: string, javaReportPath: string, outputDirectory: string): MappingTables {
  const blocks = readFileSync(join(sourceDirectory, "blocks.nbt"));
  const items = readFileSync(join(sourceDirectory, "items.json"));
  const license = readFileSync(join(sourceDirectory, "LICENSE"));
  const report = readFileSync(javaReportPath);
  verifyMappingSource("blocks.nbt", blocks);
  verifyMappingSource("items.json", items);
  verifyMappingSource("LICENSE", license);
  verifyMappingSource("java-blocks.json", report);
  const decoded = gunzipSync(blocks);
  const root = readNbt(decoded, "java");
  if (root.length !== decoded.length) throw new Error("trailing data in blocks.nbt");
  const tables: MappingTables = {
    schemaVersion: 1, source: GEYSER_SOURCE,
    ...normalizeGeyserMappings(root.tag, JSON.parse(items.toString("utf8")), JSON.parse(report.toString("utf8"))),
  };
  // 重複等を確認してから出力する。
  new MappingLookup(tables);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "LICENSE.geyser.txt"), license);
  writeFileSync(join(outputDirectory, "NOTICE.txt"), `GeyserMC mappings\n${GEYSER_SOURCE.repository}\nRevision: ${GEYSER_SOURCE.revision}\nCopyright (c) 2019-2026 GeyserMC. http://geysermc.org\nLicense: MIT (see LICENSE.geyser.txt)\nDerived ID and block-state tables; components, shapes and network runtime IDs are not included.\nGeyserMC does not relicense Minecraft or material owned by Mojang or Microsoft.\nInclude NOTICE.txt and LICENSE.geyser.txt whenever distributing these tables.\n`);
  writeFileSync(join(outputDirectory, "mappings.json"), JSON.stringify(tables) + "\n");
  return tables;
}
