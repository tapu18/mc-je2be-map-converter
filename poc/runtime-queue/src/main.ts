// #67 の固定 fixture 専用。ハンドラで観測し、runInterval で書き込みを反映する。
import {
  CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus,
  system, world, type Dimension, type Vector3,
} from "@minecraft/server";

const samplesPerPhase = 8;
const stand = "minecraft:armor_stand";
const stone = "minecraft:stone";
const blockPos = { x: 0, y: -50, z: 14 };
const spawnPos = { x: 4.5, y: -50, z: 14.5 };
const repeatPos = { x: 0, y: -50, z: 12 };

type Write =
  | { kind: "block"; type: string }
  | { kind: "spawn"; type: typeof stand; pos: Vector3 }
  | { kind: "score"; name: string; value: number }
  | { kind: "delegate"; label: string; command: string };

let queue: Write[] = [];
let armed = false;
let cbCount = 0;
let fnCount = 0;

function objective() {
  return world.scoreboard.getObjective("rt")!;
}

function trace(event: string, fields: Record<string, unknown>): void {
  console.log("RUNTIME_QUEUE " + JSON.stringify({ event, tick: system.currentTick, ...fields }));
}

function selected(pos: Vector3): boolean {
  return Math.hypot(pos.x - spawnPos.x, pos.y - spawnPos.y, pos.z - spawnPos.z) <= 2;
}

function runChain(dim: Dimension, label: string): CustomCommandStatus {
  switch (label) {
    case "place": {
      queue.push({ kind: "block", type: stone });
      const committed = dim.getBlock(blockPos)?.typeId;
      const overlay = queue.reduce((type, write) => write.kind === "block" ? write.type : type, committed);
      if (overlay === stone) queue.push({ kind: "score", name: "place_seen", value: 1 });
      trace(label, { committed, overlay });
      break;
    }
    case "summon": {
      queue.push({ kind: "spawn", type: stand, pos: spawnPos });
      const committed = dim.getEntities({ type: stand, location: spawnPos, maxDistance: 2 }).length;
      const pending = queue.filter((write) => write.kind === "spawn" && write.type === stand && selected(write.pos)).length;
      const overlay = committed + pending;
      if (overlay > 0) queue.push({ kind: "score", name: "summon_seen", value: overlay });
      trace(label, { committed, overlay });
      break;
    }
    case "ok":
    case "fail": {
      const tag = label === "ok" ? "probe_target" : "probe_missing";
      queue.push({ kind: "delegate", label, command: `tag @e[tag=${tag}] add probe_${label}` });
      trace("assumed", { label, success: true });
      break;
    }
    case "mixed": {
      const committed = objective().getScore("shared");
      queue.push({ kind: "score", name: "shared", value: 2 });
      trace(label, { committed });
      break;
    }
    case "tick": {
      if (armed && cbCount < samplesPerPhase) {
        const seen = objective().getScore("fn_value");
        queue.push({ kind: "score", name: "cb_value", value: ++cbCount });
        trace("cb", { seen, wrote: cbCount });
      }
      break;
    }
    default:
      return CustomCommandStatus.Failure;
  }
  return CustomCommandStatus.Success;
}

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  customCommandRegistry.registerCommand({
    name: "je2be:queue_probe",
    description: "Run a deferred write fixture",
    permissionLevel: CommandPermissionLevel.GameDirectors,
    mandatoryParameters: [{ name: "case", type: CustomCommandParamType.String }],
  }, (origin, label: string) => {
    const dim = origin.sourceBlock?.dimension ?? world.getDimension("overworld");
    return { status: runChain(dim, label) };
  });
});

world.afterEvents.worldLoad.subscribe(() => {
  const scores = world.scoreboard.getObjective("rt");
  armed = scores?.getScore("armed") === 1;
});

function drain(dim: Dimension): void {
  const pending = queue;
  queue = [];
  for (const write of pending) {
    switch (write.kind) {
      case "block":
        dim.getBlock(blockPos)!.setType(write.type);
        break;
      case "spawn":
        dim.spawnEntity(write.type, write.pos);
        break;
      case "score":
        if (write.name === "shared") {
          trace("mixed_drain", { before: objective().getScore("shared"), wrote: write.value });
        }
        objective().setScore(write.name, write.value);
        break;
      case "delegate":
        try {
          trace("delegated", { label: write.label, successCount: dim.runCommand(write.command).successCount });
        } catch (error) {
          trace("delegated", {
            label: write.label, successCount: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
    }
  }
}

system.runInterval(() => {
  const dim = world.getDimension("overworld");
  drain(dim);
  if (armed && fnCount < samplesPerPhase && dim.isChunkLoaded(repeatPos) &&
      dim.getBlock(repeatPos)?.typeId === "minecraft:repeating_command_block") {
    const seen = objective().getScore("cb_value");
    objective().setScore("fn_value", ++fnCount);
    trace("fn", { seen, wrote: fnCount });
  }
}, 1);
