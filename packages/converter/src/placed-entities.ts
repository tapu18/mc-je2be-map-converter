import { child, entityUuid, parseSnbt, textFormatFor, toRawText, type ItemMapping, type NbtCompound, type NbtTag } from "@je2be/core";
import type { JavaWorld } from "./java-world.ts";

export interface PlacedEntity {
  type: string;
  dimension: string;
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number };
  uuid?: string;
  name?: string;
  tags: string[];
  persistent: boolean;
  invisible?: boolean;
  professionEvent?: string;
  equipment: { slot: string; type: string; count: number; damage?: number }[];
  scores: [string, number][];
}

export interface EntityIssue {
  type: string;
  dimension: string;
  uuid?: string;
  pos?: PlacedEntity["pos"];
  field: string;
  reason: string;
}

const DIMENSIONS = new Map([
  ["minecraft:overworld", "overworld"], ["minecraft:the_nether", "nether"], ["minecraft:the_end", "the_end"],
]);
const BEDROCK_IDS = new Map([
  ["minecraft:villager", "minecraft:villager_v2"], ["minecraft:zombie_villager", "minecraft:zombie_villager_v2"],
  ["minecraft:end_crystal", "minecraft:ender_crystal"],
]);
const VILLAGER_PROFESSIONS = new Set(["armorer", "butcher", "cartographer", "cleric", "farmer", "fisherman",
  "fletcher", "leatherworker", "librarian", "mason", "shepherd", "toolsmith", "weaponsmith"]);
const JAVA_ONLY = new Set(["minecraft:marker", "minecraft:interaction", "minecraft:block_display", "minecraft:item_display", "minecraft:text_display"]);
const SPECIAL = new Set(["minecraft:item", "minecraft:item_frame", "minecraft:glow_item_frame", "minecraft:painting", "minecraft:leash_knot",
  "minecraft:experience_orb", "minecraft:lightning_bolt", "minecraft:area_effect_cloud", "minecraft:player", "minecraft:fishing_bobber"]);
const OMITTED_FIELDS = [
  "CustomNameVisible", "NoAI", "Invulnerable", "Silent", "Small", "ShowArms", "NoBasePlate", "NoGravity", "Marker",
  "Pose", "DisabledSlots", "Offers", "Age", "Owner", "Leash", "Passengers", "Inventory", "Items",
];

const string = (tag: NbtTag | undefined) => tag?.type === "string" ? tag.value : undefined;
const number = (tag: NbtTag | undefined) => tag && typeof tag.value === "number" && Number.isFinite(tag.value) ? tag.value : undefined;
const list = (tag: NbtTag | undefined) => tag?.type === "list" ? tag.value : [];

function hasNonDefault(tag: NbtTag | undefined): boolean {
  if (!tag) return false;
  if (tag.type === "compound") return tag.value.size > 0;
  if (tag.type === "list") return tag.value.length > 0;
  return tag.value !== 0;
}

function equipmentSlots(entity: NbtCompound): [string, NbtTag | undefined][] {
  const modern = child(entity, "equipment");
  const armor = list(child(entity, "ArmorItems"));
  const hands = list(child(entity, "HandItems"));
  return [
    ["Head", child(modern, "head") ?? armor[3]], ["Chest", child(modern, "chest") ?? armor[2]],
    ["Legs", child(modern, "legs") ?? armor[1]], ["Feet", child(modern, "feet") ?? armor[0]],
    ["Mainhand", child(modern, "mainhand") ?? hands[0]], ["Offhand", child(modern, "offhand") ?? hands[1]],
    ["Body", child(modern, "body")], ["Saddle", child(modern, "saddle")],
  ];
}

/** Java の保存エンティティを初期化パック用の値に変換する。 */
export function collectPlacedEntities(world: JavaWorld, legacy: boolean, dataVersion: number | undefined, items: readonly ItemMapping[]) {
  const mappings = new Map(items.map((item) => [item.javaId, item]));
  const entities: PlacedEntity[] = [];
  const skipped: EntityIssue[] = [];
  const fields: EntityIssue[] = [];
  const uuids = new Set<string>();

  function collect(entity: NbtCompound, sourceDimension: string, passenger = false): void {
    const rawType = string(child(entity, "id")) ?? "(id なし)";
    const type = /^[a-z0-9_]+$/.test(rawType) ? `minecraft:${rawType}` : rawType;
    const uuid = entityUuid(entity);
    const [x, y, z] = list(child(entity, "Pos")).map(number);
    const pos = x === undefined || y === undefined || z === undefined ? undefined : { x, y, z };
    const source = { type, dimension: sourceDimension, ...(uuid ? { uuid } : {}), ...(pos ? { pos } : {}) };
    const skip = (reason: string) => skipped.push({ ...source, field: "type", reason });
    const omit = (field: string, reason: string) => fields.push({ ...source, field, reason });
    // 同乗関係の意味を変えないよう、乗客は種類と UUID を個別にレポートする。
    for (const p of list(child(entity, "Passengers"))) if (p.type === "compound") collect(p, sourceDimension, true);
    const dimension = DIMENSIONS.get(sourceDimension);
    if (passenger) { skip("乗客の再配置は未対応"); return; }
    if (!dimension) { skip("カスタムディメンションは未対応"); return; }
    if (JAVA_ONLY.has(type)) { skip("Java 専用。代替エンティティの移植対象"); return; }
    if (!type.startsWith("minecraft:") || SPECIAL.has(type)) { skip("種類専用の再配置が必要"); return; }
    if (!pos) { skip("位置を読み取れない"); return; }
    if (uuid && uuids.has(uuid)) { skip("同じ UUID の保存エンティティが複数ある"); return; }
    if (uuid) uuids.add(uuid);

    const [yaw, pitch] = list(child(entity, "Rotation")).map(number);
    const next: PlacedEntity = {
      type: BEDROCK_IDS.get(type) ?? type, dimension, pos, rot: { x: pitch ?? 0, y: yaw ?? 0 },
      ...(uuid ? { uuid } : {}), tags: [], persistent: number(child(entity, "PersistenceRequired")) === 1, equipment: [], scores: [],
    };
    const name = child(entity, "CustomName");
    if (name) {
      let text = name;
      // 1.21.4 以前は文字列に JSON が入る。新しい版の文字列はそのままのテキスト。
      if (name.type === "string" && textFormatFor(dataVersion) === "json") {
        try { text = parseSnbt(name.value); } catch { omit("CustomName", "旧版の名前の JSON を読み取れない"); }
      }
      const converted = toRawText(text, { selector: () => ({ ok: false, message: "名前の動的セレクタは未対応" }) });
      for (const issue of converted.issues) omit("CustomName", issue.message);
      if (converted.rawtext.rawtext.some((part) => part.text === undefined)) omit("CustomName", "翻訳・スコア等の動的テキストは未対応");
      const value = converted.rawtext.rawtext.map((part) => part.text ?? "").join("");
      if (value) next.name = value;
    }
    for (const tag of list(child(entity, "Tags"))) {
      if (tag.type === "string" && tag.value.length > 0 && tag.value.length < 256) next.tags.push(tag.value);
      else omit("Tags", "空または長すぎるタグを省略");
    }
    if (number(child(entity, "Invisible")) === 1) {
      if (type === "minecraft:armor_stand") next.invisible = true;
      else omit("Invisible", "この種類の透明化は未対応");
    }
    const villager = child(entity, "VillagerData");
    if (villager) {
      const profession = string(child(villager, "profession"))?.replace(/^minecraft:/, "");
      if (type === "minecraft:villager" && profession && VILLAGER_PROFESSIONS.has(profession)) {
        next.professionEvent = `minecraft:become_${profession === "shepherd" ? "sheperd" : profession}`;
      } else if (profession && profession !== "none") omit("VillagerData.profession", "職業に対応する初期化イベントがない");
      if ((number(child(villager, "level")) ?? 1) !== 1) omit("VillagerData.level", "取引レベルの復元は未対応");
      const variant = string(child(villager, "type"));
      if (variant) omit("VillagerData.type", `${variant} の服装を明示的に指定できない`);
    }
    for (const field of OMITTED_FIELDS) {
      if (hasNonDefault(child(entity, field))) omit(field, "保存値の復元は未対応");
    }
    for (const [slot, stack] of equipmentSlots(entity)) {
      const id = string(child(stack, "id"));
      const count = number(child(stack, "count") ?? child(stack, "Count")) ?? 1;
      if (!id || id === "minecraft:air" || count <= 0) continue;
      const field = `equipment.${slot}`;
      const mapping = mappings.get(id);
      if (!/^minecraft:[a-z0-9_]+$/.test(mapping?.bedrockId ?? id) || !Number.isSafeInteger(count) || (mapping?.data ?? 0) !== 0 || slot === "Body" || slot === "Saddle") {
        omit(field, `${id} のスロットまたはデータ値は未対応`);
        continue;
      }
      const components = child(stack, "components");
      const damage = number(child(components, "minecraft:damage"));
      if ((components?.type === "compound" && [...components.value.keys()].some((key) => key !== "minecraft:damage")) || child(stack, "tag")) {
        omit(field, `${id} の追加データを省略`);
      }
      next.equipment.push({ slot, type: mapping?.bedrockId ?? id, count, ...(damage === undefined ? {} : { damage }) });
    }
    entities.push(next);
  }
  for (const dimension of world.dimensions()) for (const entity of world.entities(dimension, legacy)) collect(entity, dimension);
  return { entities, report: { scheduled: entities.length, skipped, fields } };
}

export type PlacedEntityReport = ReturnType<typeof collectPlacedEntities>["report"];
