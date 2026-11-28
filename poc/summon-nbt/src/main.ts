// NBT 付き summon の上位キー（#357）を、召喚の直後に Script API で設定して読み戻す PoC。
// `scriptevent je2be:summon <JSON {id, op}>` を受け、`POC_SUMMON <JSON {id, ok, result|error}>` を出す。
// 各試行は独立に try し、例外も結果として返す（どの手段が使えないかを記録するため）。
import { EquipmentSlot, ItemStack, system, world, type Entity } from "@minecraft/server";

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function attempt<T>(f: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

const dimension = () => world.getDimension("overworld");
const round = (n: number) => Math.round(n * 1000) / 1000;
const rotation = (e: Entity) => { const r = e.getRotation(); return { x: round(r.x), y: round(r.y) }; };

/** 召喚の直後（同じ tick）に設定し、その場で読み戻す。次の tick にも読み戻す */
function probe(type: string, x: number, apply: (e: Entity) => Record<string, unknown>): Promise<Record<string, unknown>> {
  const at = { x: x + 0.5, y: -60, z: 0.5 };
  const e = dimension().spawnEntity(type as Parameters<ReturnType<typeof dimension>["spawnEntity"]>[0], at, { initialRotation: 90 });
  const immediate = { type: e.typeId, initialRotation: rotation(e), ...apply(e) };
  return new Promise((resolve) => system.run(() => resolve({ ...immediate, nextTick: readBack(e) })));
}

function readBack(e: Entity): Record<string, unknown> {
  return {
    valid: e.isValid,
    tags: attempt(() => e.getTags().sort()),
    rotation: attempt(() => rotation(e)),
    nameTag: attempt(() => e.nameTag),
    dynamic: attempt(() => e.getDynamicProperty("je2be:nbt")),
    mainhand: attempt(() => e.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand)?.typeId ?? null),
    head: attempt(() => e.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Head)?.typeId ?? null),
  };
}

// 表示用エンティティの値（transformation・billboard・text・background・teleport_duration・width・height）の代表。
// BE に対応する欄がないため、ランタイムが JSON の文字列で動的プロパティに持つ案を試す
const displayValues = JSON.stringify({
  transformation: { translation: [0, 0.5, 0], left_rotation: [0, 0, 0, 1], scale: [2, 2, 2], right_rotation: [0, 0, 0, 1] },
  billboard: "center", text: { text: "Hello", color: "gold" }, background: 0x40000000, teleport_duration: 3,
  width: 1.5, height: 2.25,
});

function applyAll(e: Entity): Record<string, unknown> {
  return {
    addTag: attempt(() => ["je2be_a", "je2be_b", "je2be_c"].map((t) => e.addTag(t))),
    setRotation: attempt(() => { e.setRotation({ x: 30, y: -45 }); return rotation(e); }),
    nameTag: attempt(() => { e.nameTag = "Hello\nWorld"; return e.nameTag; }),
    dynamic: attempt(() => { e.setDynamicProperty("je2be:nbt", displayValues); return (e.getDynamicProperty("je2be:nbt") as string).length; }),
    setMainhand: attempt(() => e.getComponent("minecraft:equippable")?.setEquipment(EquipmentSlot.Mainhand, new ItemStack("minecraft:diamond_sword")) ?? "no equippable"),
    setHead: attempt(() => e.getComponent("minecraft:equippable")?.setEquipment(EquipmentSlot.Head, new ItemStack("minecraft:carved_pumpkin")) ?? "no equippable"),
    immediate: readBack(e),
  };
}

/** BE の summon コマンドの引数（向き・名前）で書けるかを試す */
function summonCommand(): Record<string, unknown> {
  const d = dimension();
  const out: Record<string, unknown> = {};
  const cases: Record<string, [string, string]> = {
    rotation: ["summon armor_stand 20.5 -60 0.5 90 30", "je2be_cmd_rot"],
    nameTag: ["summon armor_stand 22.5 -60 0.5 0 0 minecraft:entity_spawned \"Named\"", "je2be_cmd_name"],
    zombieRotation: ["summon zombie 24.5 -60 0.5 90 30", "je2be_cmd_zrot"],
  };
  for (const [key, [command, tag]] of Object.entries(cases)) {
    const r = attempt(() => d.runCommand(command).successCount);
    const x = Number(command.split(" ")[2]);
    const found = d.getEntities({ location: { x, y: -60, z: 0.5 }, maxDistance: 0.5 });
    for (const e of found) e.addTag(tag);
    out[key] = { successCount: r, entities: found.map((e) => ({ type: e.typeId, rotation: rotation(e), nameTag: e.nameTag })) };
  }
  // 手持ち・頭の装備は Script API で書けない（equippable はプレイヤーだけ）ため、replaceitem で書き hasitem で読む
  for (const tag of ["je2be_cmd_rot", "je2be_cmd_zrot"]) {
    const run = (command: string) => attempt(() => d.runCommand(command).successCount);
    out[`equipment_${tag}`] = {
      setMainhand: run(`replaceitem entity @e[tag=${tag}] slot.weapon.mainhand 0 diamond_sword`),
      setHead: run(`replaceitem entity @e[tag=${tag}] slot.armor.head 0 carved_pumpkin`),
      hasMainhand: run(`testfor @e[tag=${tag},hasitem={item=diamond_sword,location=slot.weapon.mainhand}]`),
      hasHead: run(`testfor @e[tag=${tag},hasitem={item=carved_pumpkin,location=slot.armor.head}]`),
    };
  }
  return out;
}

const ops: Record<string, () => Promise<unknown> | unknown> = {
  scripted: async () => ({
    armor_stand: await probe("minecraft:armor_stand", 0, applyAll),
    zombie: await probe("minecraft:zombie", 4, applyAll),
  }),
  command: summonCommand,
};

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "je2be:summon") return;
  const req = JSON.parse(ev.message) as { id: number; op: string };
  const reply = (body: Record<string, unknown>) => console.log("POC_SUMMON " + JSON.stringify({ id: req.id, ...body }));
  const op = ops[req.op];
  if (!op) return reply({ ok: false, error: `unknown op: ${req.op}` });
  Promise.resolve().then(op).then((result) => reply({ ok: true, result }), (e: unknown) => reply({ ok: false, error: errText(e) }));
});
