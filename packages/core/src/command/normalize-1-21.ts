import type { CommandIR, ParsedNode } from "./parser.ts";
import { uuidToInts } from "./snbt.ts";

// Java 1.21 の AttributeModifierIdFix で UUID が固定されている旧 modifier。
const BUILTIN_IDS = new Map([
  ["736565d2-e1a7-403d-a3f8-1aeb3e302542", "creative_mode_block_range"],
  ["98491ef6-97b1-4584-ae82-71a8cc85cf73", "creative_mode_entity_range"],
  ["91aeaa56-376b-4498-935b-2f7f68070635", "effect.speed"],
  ["7107de5e-7ce8-4030-940e-514c1f160890", "effect.slowness"],
  ["af8b6e3f-3328-4c0a-aa36-5ba2bb9dbef3", "effect.haste"],
  ["55fced67-e92a-486e-9800-b47f202c4386", "effect.mining_fatigue"],
  ["648d7064-6a60-4f59-8abe-c2c23a6dd7a9", "effect.strength"],
  ["c0105bf3-aef8-46b0-9ebc-92943757ccbe", "effect.jump_boost"],
  ["22653b89-116e-49dc-9b6b-9971489b5be5", "effect.weakness"],
  ["5d6f0ba2-1186-46ac-b896-c61c5cee99cc", "effect.health_boost"],
  ["eae29cf0-701e-4ed6-883a-96f798f3dab5", "effect.absorption"],
  ["03c3c89d-7037-4b42-869f-b146bcb64d2e", "effect.luck"],
  ["cc5af142-2bd2-4215-b636-2605aed11727", "effect.unluck"],
  ["6555be74-63b3-41f1-a245-77833b3c2562", "evil"],
  ["1eaf83ff-7207-4596-b37a-d7a07b3ec4ce", "powder_snow"],
  ["662a6b8d-da3e-4c1c-8813-96ea6097278d", "sprinting"],
  ["020e0dfb-87ae-4653-9556-831010e291a0", "attacking"],
  ["766bfa64-11f3-11ea-8d71-362b9e155667", "baby"],
  ["7e0292f2-9434-48d5-a29f-9583af7df27f", "covered"],
  ["9e362924-01de-4ddd-a2b2-d0f7a405a174", "suffocating"],
  ["5cd17e52-a79a-43d3-a529-90fde04b181e", "drinking"],
  ["b9766b59-9566-4402-bc1f-2ee2a276d836", "baby"],
  ["49455a49-7ec5-45ba-b886-3b90b23a1718", "attacking"],
  ["845db27c-c624-495f-8c9f-6020a9a58b6b", "armor.boots"],
  ["d8499b04-0e66-4726-ab29-64469d734e0d", "armor.leggings"],
  ["9f3d476d-c118-4544-8365-64846904b48e", "armor.chestplate"],
  ["2ad3f246-fee1-4e67-b886-69fd380bb150", "armor.helmet"],
  ["c1c72771-8b8e-ba4a-ace0-81a93c8928b2", "armor.body"],
  ["b572ecd2-ac0c-4071-abde-9594af072a37", "enchantment.fire_protection"],
  ["40a9968f-5c66-4e2f-b7f4-2ec2f4b3e450", "enchantment.blast_protection"],
  ["07a65791-f64d-4e79-86c7-f83932f007ec", "enchantment.respiration"],
  ["60b1b7db-fffd-4ad0-817c-d6c6a93d8a45", "enchantment.aqua_affinity"],
  ["11dc269a-4476-46c0-aff3-9e17d7eb6801", "enchantment.depth_strider"],
  ["87f46a96-686f-4796-b035-22e16ee9e038", "enchantment.soul_speed"],
  ["b9716dbd-50df-4080-850e-70347d24e687", "enchantment.soul_speed"],
  ["92437d00-c3a7-4f2e-8f6c-1f21585d5dd0", "enchantment.swift_sneak"],
  ["5d3d087b-debe-4037-b53e-d84f3ff51f17", "enchantment.sweeping_edge"],
  ["3ceb37c0-db62-46b5-bd02-785457b01d96", "enchantment.efficiency"],
  ["cb3f55d3-645c-4f38-a497-9c13a33db5cf", "base_attack_damage"],
  ["fa233e1c-4180-4865-b01b-bcce9785aca3", "base_attack_speed"],
]);

function normalizeModifier(nodes: ParsedNode[]): ParsedNode[] {
  const uuidIndex = nodes.findIndex(node => node.kind === "argument" && node.name === "uuid" && node.parser === "minecraft:uuid");
  const uuid = nodes[uuidIndex];
  if (uuid?.value?.kind !== "word") return nodes;
  const ints = uuidToInts(uuid.value.value);
  if (!ints) return nodes;
  const hex = Array.from(ints, part => (part >>> 0).toString(16).padStart(8, "0")).join("");
  const canonical = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  const id: ParsedNode = {
    ...uuid, name: "id", parser: "minecraft:resource_location",
    value: { kind: "resource", id: `minecraft:${BUILTIN_IDS.get(canonical) ?? canonical}`, tag: false },
  };
  // modifier add だけに UUID の直後の表示名がある。
  const next = nodes[uuidIndex + 1];
  const hasName = next?.kind === "argument" && next.name === "name" && next.parser === "brigadier:string";
  return [...nodes.slice(0, uuidIndex), id, ...nodes.slice(uuidIndex + (hasName ? 2 : 1))];
}

/** 1.20.6 → 1.21: attribute modifier の add / remove / value get に共通の ID を使う。 */
export function normalize1_21Attribute(ir: CommandIR): CommandIR {
  const command = ir.command;
  if (!command) return ir;
  const nodes = command.name === "attribute" ? normalizeModifier(command.nodes) : command.nodes;
  return { ...ir, command: { ...command, nodes, ...(command.run ? { run: normalize1_21Attribute(command.run) } : {}) } };
}
