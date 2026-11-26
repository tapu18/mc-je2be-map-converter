import type { NbtCompound, NbtTag } from "../nbt/nbt.ts";
import { readNbtPath, type ArgumentValue, type ItemComponent, type NbtPathNode } from "./arguments.ts";
import { normalizeArguments } from "./normalize-arguments.ts";
import type { CommandNormalization } from "./normalize-command.ts";
import type { CommandIR, ParsedNode } from "./parser.ts";
import { CommandSyntaxError, StringReader } from "./reader.ts";
import { parseSnbt } from "./snbt.ts";

const CUSTOM_DATA = "minecraft:custom_data";
const CUSTOM_MODEL_DATA = "minecraft:custom_model_data";

// ItemStackComponentizationFix in Java 1.20.5 also consumes item-specific keys.
// Reserve them even when the item ID is a tag or the path does not constrain the ID.
const VANILLA_ITEM_KEYS = new Set([
  "Age", "AttributeModifiers", "BlockEntityTag", "BlockStateTag", "BucketVariantTag", "CanDestroy",
  "CanPlaceOn", "Charged", "ChargedProjectiles", "CustomModelData", "CustomPotionColor", "Damage",
  "DebugProperty", "Decorations", "Enchantments", "EntityTag", "Explosion", "Fireworks", "Glowing",
  "Health", "HideFlags", "HuntingCooldown", "Invulnerable", "Items", "LodestoneDimension", "LodestonePos",
  "LodestoneTracked", "NoAI", "NoGravity", "Potion", "Recipes", "RepairCost", "Silent", "SkullOwner",
  "StoredEnchantments", "Trim", "Unbreakable", "Variant", "author", "custom_potion_effects", "display",
  "effects", "filtered_pages", "filtered_title", "generation", "instrument", "pages", "resolved", "title",
]);

function customDataProblem(tag: NbtCompound): string | undefined {
  if (!tag.value.size) return "空の旧アイテム tag の有無を保持できない";
  for (const key of tag.value.keys()) {
    if (VANILLA_ITEM_KEYS.has(key)) return `旧アイテム NBT の '${key}' は専用コンポーネントへの変換が必要`;
  }
  return undefined;
}

function normalizeItemTag(tag: NbtCompound): (ItemComponent & { value: NbtTag })[] | string {
  const model = tag.value.get("CustomModelData");
  const customData: NbtCompound = { type: "compound", value: new Map(tag.value) };
  customData.value.delete("CustomModelData");
  const components: (ItemComponent & { value: NbtTag })[] = [];
  if (model) {
    if (model.type !== "int" || !Number.isInteger(model.value) || model.value < -2147483648 || model.value > 2147483647) {
      return "旧アイテム NBT の CustomModelData を 32 ビット整数として保持できない";
    }
    components.push({ key: CUSTOM_MODEL_DATA, removed: false, value: model });
  }
  if (customData.value.size || !model) {
    const problem = customDataProblem(customData);
    if (problem) return problem;
    components.push({ key: CUSTOM_DATA, removed: false, value: customData });
  }
  return components;
}

const ENTITY_ITEMS = new Set(["Item", "SelectedItem", "item"]);
const ENTITY_ITEM_LISTS = new Set(["Inventory", "EnderItems", "HandItems", "ArmorItems", "Items"]);
const keyNode = (key: string): NbtPathNode => ({ kind: "key", key });
const keyOf = (node: NbtPathNode | undefined): string | undefined => node?.kind === "key" ? node.key : undefined;

function containsTagKey(tag: NbtTag): boolean {
  if (tag.type === "compound") return tag.value.has("tag") || [...tag.value.values()].some(containsTagKey);
  return tag.type === "list" && tag.value.some(containsTagKey);
}

function hasTagPath(path: NbtPathNode[]): boolean {
  return path.some(node => keyOf(node) === "tag" || (node.kind === "filter" && containsTagKey(node.filter)));
}

function stableStackFilter(filter: NbtTag): boolean {
  return filter.type === "compound" && [...filter.value].every(([key, tag]) =>
    (key === "Slot" && tag.type === "byte") || (key === "id" && tag.type === "string"));
}

function normalizePath(path: NbtPathNode[], source: string | undefined, writable: boolean): NbtPathNode[] | string {
  if (source === "storage" || !hasTagPath(path)) return path;
  if (writable) return "旧アイテム tag の書き込み・削除はコンポーネントの検証や生成を伴う";
  const root = keyOf(path[0]);
  let tagIndex: number | undefined;
  if (root && source === "entity" && ENTITY_ITEMS.has(root)) tagIndex = 1;
  if (root && (source === "entity" && ENTITY_ITEM_LISTS.has(root) || source === "block" && root === "Items")) {
    const entry = path[1];
    if (entry?.kind === "index" || entry?.kind === "all" || (entry?.kind === "filter" && stableStackFilter(entry.filter))) tagIndex = 2;
  }
  if (tagIndex === undefined || keyOf(path[tagIndex]) !== "tag") {
    return "旧アイテム tag を参照する NBT パスの対象またはフィルタを変換できない";
  }
  const key = keyOf(path[tagIndex + 1]);
  if (key === undefined || VANILLA_ITEM_KEYS.has(key)) return "旧アイテム tag 全体または専用フィールドを参照する NBT パスを変換できない";
  return [...path.slice(0, tagIndex), keyNode("components"), keyNode(CUSTOM_DATA), ...path.slice(tagIndex + 1)];
}

// JSON ops can preserve strings and booleans (NBT bytes 0/1) without coercing
// the numeric width or losing the distinction between a typed array and a list.
function jsonCustomData(tag: NbtTag): boolean {
  if (tag.type === "compound") return [...tag.value.values()].every(jsonCustomData);
  return tag.type === "string" || (tag.type === "byte" && (tag.value === 0 || tag.value === 1));
}

function normalizeHover(hover: NbtCompound): NbtCompound | string {
  const action = hover.value.get("action")?.value;
  const contents = hover.value.get("contents");
  if (action === "show_text") return normalizeTextFields(hover, ["contents", "value"]);
  if (action === "show_entity" && contents?.type === "compound") {
    const entity = normalizeTextFields(contents, ["name"]);
    if (typeof entity === "string") return entity;
    return { type: "compound", value: new Map(hover.value).set("contents", entity) };
  }
  if (action !== "show_item") return hover;
  if (hover.value.has("value")) return "show_item の旧 value 形式を変換できない";
  if (contents?.type !== "compound") return hover;
  if (contents.value.has("components")) return "旧 show_item の components は版によって解釈が異なる";
  const legacy = contents.value.get("tag");
  if (!legacy) return hover;
  if (legacy.type !== "string") return "show_item の旧 tag に SNBT 文字列が必要";
  const tag = parseSnbt(legacy.value);
  if (tag.type !== "compound") return "show_item の旧 tag に SNBT 複合タグが必要";
  const problem = customDataProblem(tag);
  if (problem) return problem;
  if (!jsonCustomData(tag)) return "show_item の旧 tag の NBT 型を JSON で保持できない";
  const count = contents.value.get("count");
  if (count && (count.type !== "int" || count.value < 1 || count.value > 99)) return "show_item の個数を保持できない";
  const item = new Map(contents.value);
  item.delete("tag");
  item.set("components", { type: "compound", value: new Map([[CUSTOM_DATA, tag]]) });
  return { type: "compound", value: new Map(hover.value).set("contents", { type: "compound", value: item }) };
}

function normalizeTextFields(tag: NbtCompound, keys: string[]): NbtCompound | string {
  const value = new Map(tag.value);
  for (const key of keys) {
    const child = value.get(key);
    if (!child) continue;
    const converted = normalizeText(child);
    if (typeof converted === "string") return converted;
    value.set(key, converted);
  }
  return { type: "compound", value };
}

function normalizeText(tag: NbtTag): NbtTag | string {
  if (tag.type === "list") {
    const value: NbtTag[] = [];
    for (const child of tag.value) {
      // readJsonText wraps non-compound entries of heterogeneous lists with the empty key.
      const converted = child.type === "compound" && child.value.size === 1 && child.value.has("")
        ? normalizeTextFields(child, [""]) : normalizeText(child);
      if (typeof converted === "string") return converted;
      value.push(converted);
    }
    return { ...tag, value };
  }
  if (tag.type !== "compound") return tag;
  const nbt = tag.value.get("nbt");
  if (nbt?.type === "string" && (tag.value.has("entity") || tag.value.has("block")) &&
    hasTagPath(readNbtPath(new StringReader(nbt.value)))) return "JSON テキスト内の旧アイテム tag 参照を変換できない";
  const converted = normalizeTextFields(tag, ["extra", "with", "separator"]);
  if (typeof converted === "string") return converted;
  const hover = converted.value.get("hoverEvent");
  if (hover?.type !== "compound") return converted;
  const migrated = normalizeHover(hover);
  if (typeof migrated === "string") return migrated;
  converted.value.set("hoverEvent", migrated);
  return converted;
}

function normalizeValue(nodes: ParsedNode[], index: number, owner: string): ArgumentValue | string | undefined {
  const node = nodes[index]!;
  const value = node.value;
  if ((value?.kind === "item" || value?.kind === "itemPredicate") && value.legacyTag) {
    const { kind, id, tag, legacyTag } = value;
    const components = normalizeItemTag(legacyTag);
    if (typeof components === "string") return components;
    return kind === "item"
      ? { kind, id, tag, components }
      : { kind, id, tag, alternatives: [components.map(({ key, value }) =>
        ({ key, value, negated: false, op: key === CUSTOM_DATA ? "~" : "=" }))] };
  }
  if (value?.kind === "nbtPath") {
    // The source literal precedes the single block position, entity or storage ID argument.
    const source = nodes[index - 2]?.name;
    const writable = owner === "store" || (owner === "data" && (node.name === "targetPath" || nodes[0]?.name === "remove"));
    const path = normalizePath(value.path, source, writable);
    return typeof path === "string" ? path : { ...value, path };
  }
  if (value?.kind === "text" && value.format === "json") {
    try {
      const text = normalizeText(value.value);
      return typeof text === "string" ? text : { ...value, value: text };
    } catch (error) {
      if (!(error instanceof CommandSyntaxError)) throw error;
      return `JSON テキスト内の旧 NBT を解析できない（${error.message}）`;
    }
  }
  return undefined;
}

/** Java 1.20.4 → 1.20.5. 元のコマンド文字列と診断位置を保持する。 */
export function normalize1_20_5ItemsAndText(ir: CommandIR): CommandNormalization {
  return normalizeArguments(ir, normalizeValue);
}
