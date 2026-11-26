import type { NbtTag } from "../nbt/nbt.ts";
import type { ArgumentValue, ItemComponent, ItemPredicateTest } from "./arguments.ts";
import { normalizeArguments } from "./normalize-arguments.ts";
import type { CommandNormalization } from "./normalize-command.ts";
import type { CommandIR } from "./parser.ts";

function normalizeModelData<T extends ItemComponent | ItemPredicateTest>(entry: T): T | string {
  if (entry.key !== "minecraft:custom_model_data" || ("negated" in entry && entry.op !== "=") || !entry.value) return entry;
  const old = entry.value;
  const n = old.value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < -2147483648 || n > 2147483647 || Math.fround(n) !== n) {
    return "custom_model_data の整数を float に正確に変換できない";
  }
  if ("negated" in entry && (Math.fround(n - 1) === n || Math.fround(n + 1) === n)) {
    return "custom_model_data 述語の隣接する整数が同じ float になる";
  }
  const floats: NbtTag = { type: "list", elementType: "float", value: [{ type: "float", value: n }] };
  return { ...entry, value: { type: "compound", value: new Map([["floats", floats]]) } };
}

function convertEntries<T>(entries: T[], apply: (entry: T) => T | string): T[] | string {
  const result: T[] = [];
  for (const entry of entries) {
    const converted = apply(entry);
    if (typeof converted === "string") return converted;
    result.push(converted);
  }
  return result;
}

function normalizeItem(value: ArgumentValue | undefined): ArgumentValue | string | undefined {
  if (value?.kind === "item") {
    const components = convertEntries(value.components, normalizeModelData);
    return typeof components === "string" ? components : { ...value, components };
  }
  if (value?.kind === "itemPredicate") {
    const alternatives = convertEntries(value.alternatives, group => convertEntries(group, normalizeModelData));
    return typeof alternatives === "string" ? alternatives : { ...value, alternatives };
  }
  return value;
}

/** 1.21.3 → 1.21.4: Integer model data on item arguments becomes the first element of floats. */
export function normalize1_21_4CustomModelData(ir: CommandIR): CommandNormalization {
  return normalizeArguments(ir, (nodes, index) => normalizeItem(nodes[index]?.value));
}
