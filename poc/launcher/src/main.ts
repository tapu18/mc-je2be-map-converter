// 起動口のPoC。コマンドブロックから呼ばれたときの挙動を `POC <JSON>` としてコンソールに記録する。
// 記録の読み方は launcher.servers.test.ts を参照。
import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  system,
  world,
  type Block,
  type CustomCommandOrigin,
  type Dimension,
} from "@minecraft/server";

function log(event: string, data: Record<string, unknown>): void {
  console.log("POC " + JSON.stringify({ event, tick: system.currentTick, ...data }));
}

function score(name: string): number | undefined {
  // 一度もスコアを持ったことのない名前は getScore が例外を投げる
  try {
    return world.scoreboard.getObjective("t")?.getScore(name);
  } catch {
    return undefined;
  }
}

function blockInfo(b: Block | undefined): unknown {
  return b ? { pos: [b.location.x, b.location.y, b.location.z], dim: b.dimension.id, type: b.typeId } : null;
}

function originInfo(o: CustomCommandOrigin): unknown {
  return {
    sourceType: o.sourceType,
    sourceBlock: blockInfo(o.sourceBlock),
    sourceEntity: o.sourceEntity?.typeId ?? null,
    initiator: o.initiator?.typeId ?? null,
  };
}

/** 操作を試し、成功・失敗（エラー名と文言）を返す */
function attempt(fn: () => unknown): { ok: true; value?: unknown } | { ok: false; error: string } {
  try {
    const value = fn();
    return value === undefined ? { ok: true } : { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

function restrictedOps(dim: Dimension, label: string): Record<string, unknown> {
  return {
    readScore: attempt(() => score(`seq_${label}`)),
    writeScore: attempt(() => world.scoreboard.getObjective("t")?.setScore(`w_${label}`, 1)),
    runCommand: attempt(() => dim.runCommand(`scoreboard players set rc_${label} t 1`).successCount),
    getBlock: attempt(() => dim.getBlock({ x: 0, y: -61, z: 0 })?.typeId),
    setBlock: attempt(() => dim.getBlock({ x: 60, y: -50, z: 60 })?.setType("minecraft:stone")),
    getEntities: attempt(() => dim.getEntities().length),
    spawnEntity: attempt(() => dim.spawnEntity("minecraft:armor_stand", { x: 60.5, y: -60, z: 60.5 }).id),
    setDynamicProperty: attempt(() => world.setDynamicProperty(`dp_${label}`, 1)),
    getDynamicProperty: attempt(() => world.getDynamicProperty(`dp_${label}`)),
  };
}

system.beforeEvents.startup.subscribe((ev) => {
  const reg = ev.customCommandRegistry;
  const level = CommandPermissionLevel.GameDirectors;
  const labelParam = { name: "label", type: CustomCommandParamType.String };

  reg.registerCommand({ name: "je2be:ok", description: "常に成功", permissionLevel: level }, () => ({
    status: CustomCommandStatus.Success,
  }));
  reg.registerCommand({ name: "je2be:fail", description: "常に失敗", permissionLevel: level }, () => ({
    status: CustomCommandStatus.Failure,
    message: "poc failure",
  }));
  // 戻り値なし（undefined）のとき成否はどう扱われるか
  reg.registerCommand({ name: "je2be:void", description: "何も返さない", permissionLevel: level }, () => undefined);

  // 実行順の確認：ハンドラ内と遅延実行内でスコアを読み、遅延実行内で書く
  reg.registerCommand(
    { name: "je2be:probe", description: "順序の確認", permissionLevel: level, mandatoryParameters: [labelParam] },
    (origin, label: string) => {
      log("probe.handler", { label, seq: score(`seq_${label}`), origin: originInfo(origin) });
      system.run(() => {
        const dim = world.getDimension("overworld");
        const r = dim.runCommand(`scoreboard players set w_${label} t 1`);
        log("probe.deferred", { label, seq: score(`seq_${label}`), successCount: r.successCount, readBack: score(`w_${label}`) });
      });
      return { status: CustomCommandStatus.Success };
    },
  );

  // ハンドラ内で許される操作
  reg.registerCommand(
    { name: "je2be:restrict", description: "制限の確認", permissionLevel: level, mandatoryParameters: [labelParam] },
    (origin, label: string) => {
      const dim = origin.sourceBlock?.dimension ?? world.getDimension("overworld");
      log("restrict.handler", { label, ops: restrictedOps(dim, `${label}h`) });
      system.run(() => log("restrict.deferred", { label, ops: restrictedOps(dim, `${label}d`) }));
      return { status: CustomCommandStatus.Success };
    },
  );

  // 実行コンテキストの確認
  reg.registerCommand(
    { name: "je2be:ctx", description: "文脈の確認", permissionLevel: level, mandatoryParameters: [labelParam] },
    (origin, label: string) => {
      log("ctx.custom", { label, origin: originInfo(origin) });
      return { status: CustomCommandStatus.Success };
    },
  );

  // 引数で実行コンテキストを渡す：位置（~ ~ ~）、実行者（@s）、向き（^ ^ ^1 との差）
  reg.registerCommand(
    {
      name: "je2be:ctxarg",
      description: "引数で文脈を渡す",
      permissionLevel: level,
      mandatoryParameters: [labelParam, { name: "pos", type: CustomCommandParamType.Location }],
      optionalParameters: [
        { name: "forward", type: CustomCommandParamType.Location },
        { name: "executor", type: CustomCommandParamType.EntitySelector },
      ],
    },
    (origin, label: string, pos: unknown, forward: unknown, executor: unknown) => {
      const ents = Array.isArray(executor)
        ? executor.map((e: { typeId: string; getTags(): string[]; dimension: Dimension }) => ({ type: e.typeId, tags: e.getTags(), dim: e.dimension.id }))
        : executor;
      log("ctx.arg", { label, pos, forward, executor: ents, origin: originInfo(origin) });
      return { status: CustomCommandStatus.Success };
    },
  );
});

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (!ev.id.startsWith("je2be:")) return;
  if (ev.id === "je2be:req") return; // 検証ブリッジ用
  const label = ev.message;
  const dim = world.getDimension("overworld");
  if (ev.id === "je2be:ev") {
    log("scriptevent", { label, seq: score(`seq_${label}`), sourceType: ev.sourceType, sourceBlock: blockInfo(ev.sourceBlock) });
    const r = dim.runCommand(`scoreboard players set w_${label} t 1`);
    log("scriptevent.write", { label, successCount: r.successCount, readBack: score(`w_${label}`) });
  } else if (ev.id === "je2be:ops") {
    log("scriptevent.ops", { label, ops: restrictedOps(dim, `${label}s`) });
  }
});

system.run(() => log("ready", {}));
