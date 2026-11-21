// 生成パック内で実行するコード。利用 API の型は packages/bridge-pack が固定する @minecraft/server と同じ。
export const restoreEntitiesScript = `
const PROGRESS = "je2be:entity_progress";
const AREA = "je2be_entity_init";
const BATCH_SIZE = 32;
const ARMOR_STAND_SLOTS = {
  Head: "slot.armor.head", Chest: "slot.armor.chest", Legs: "slot.armor.legs", Feet: "slot.armor.feet",
  Mainhand: "slot.weapon.mainhand", Offhand: "slot.weapon.offhand"
};

async function restoreEntities() {
  let index = world.getDynamicProperty(PROGRESS);
  if (index >= ENTITIES.length) return 0;
  const areas = world.tickingAreaManager;
  let failures = 0;
  const report = (entry, field, error) => {
    failures++;
    console.warn("[je2be] entity " + JSON.stringify({
      type: entry.type, uuid: entry.uuid, dimension: entry.dimension, pos: entry.pos, field, error: String(error)
    }));
  };
  while (index < ENTITIES.length) {
    const first = ENTITIES[index];
    const dimension = world.getDimension(first.dimension);
    const chunkX = Math.floor(first.pos.x / 16);
    const chunkZ = Math.floor(first.pos.z / 16);
    let end = index + 1;
    while (end < ENTITIES.length) {
      const next = ENTITIES[end];
      if (next.dimension !== first.dimension || Math.floor(next.pos.x / 16) !== chunkX || Math.floor(next.pos.z / 16) !== chunkZ) break;
      end++;
    }
    let area = false;
    try {
      // プレイヤーが近くにいないディメンションとチャンクも一時的に読み込む。
      const corner = { x: chunkX * 16, y: 0, z: chunkZ * 16 };
      await areas.createTickingArea(AREA, { dimension, from: corner, to: corner });
      area = true;
      while (index < end) {
        const entry = ENTITIES[index];
        const attempt = (field, run) => {
          try { run(); } catch (error) { report(entry, field, error); }
        };
        attempt("spawn", () => {
          const entity = dimension.spawnEntity(entry.type, entry.pos, { initialRotation: entry.rot.y, initialPersistence: entry.persistent || undefined });
          attempt("Rotation", () => entity.setRotation(entry.rot));
          if (entry.invisible) attempt("Invisible", () => {
            const result = entity.runCommand("effect @s invisibility infinite 0 true");
            if (!result.successCount) throw Error("invisibility was rejected");
          });
          if (entry.professionEvent) attempt("VillagerData.profession", () => entity.triggerEvent(entry.professionEvent));
          if (entry.name !== undefined) attempt("CustomName", () => { entity.nameTag = entry.name; });
          for (const tag of entry.tags) attempt("Tags", () => {
            if (!entity.addTag(tag) && !entity.hasTag(tag)) throw Error("tag was rejected: " + tag);
          });
          for (const item of entry.equipment) attempt("equipment." + item.slot, () => {
            if (entry.type === "minecraft:armor_stand") {
              const slot = ARMOR_STAND_SLOTS[item.slot];
              const result = entity.runCommand("replaceitem entity @s " + slot + " 0 " + item.type + " " + item.count + " " + (item.damage ?? 0));
              if (!result.successCount) throw Error("equipment was rejected");
              return;
            }
            const stack = new ItemStack(item.type, item.count);
            const durability = stack.getComponent("minecraft:durability");
            if (item.damage !== undefined) {
              if (!durability) throw Error("item has no durability");
              durability.damage = item.damage;
            }
            if (!entity.getComponent("minecraft:equippable")?.setEquipment(item.slot, stack)) throw Error("equipment was rejected");
          });
          for (const [objective, score] of entry.scores) attempt("score." + objective, () => {
            world.scoreboard.getObjective(objective).setScore(entity, score);
          });
        });
        index++;
        world.setDynamicProperty(PROGRESS, index);
        if (index % BATCH_SIZE === 0) await system.waitTicks(1);
      }
    } catch (error) {
      // 残りのエンティティは次のワールド読み込みで再試行する。
      report(ENTITIES[index] ?? first, "chunk", error);
      throw error;
    } finally {
      if (area) areas.removeTickingArea(AREA);
    }
  }
  return failures;
}
`;
