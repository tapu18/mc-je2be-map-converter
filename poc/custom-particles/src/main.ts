import { CommandPermissionLevel, CustomCommandStatus, MolangVariableMap, system, world } from "@minecraft/server";
import { register } from "@minecraft/server-gametest";

const pos = { x: 8.5, y: -58, z: 8.5 };
function variables(): MolangVariableMap {
  const v = new MolangVariableMap();
  v.setColorRGB("variable.color", { red: 1, green: 0.2, blue: 0.1 });
  v.setFloat("variable.size", 0.3);
  v.setFloat("variable.speed", 0.1);
  v.setVector3("variable.direction", { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() * 2 - 1 });
  return v;
}
function attempt(f: () => void): string {
  try { f(); return "ok"; } catch (e) { return String(e); }
}
function log(data: object): void { console.log("PARTICLE_POC " + JSON.stringify(data)); }
register("je2be", "particle_listener", (test) => {
  test.spawnSimulatedPlayer({ x: 0, y: 0, z: 0 }, "Listener");
  console.log("PARTICLE_LISTENER_READY");
}).structureName("je2be:empty").maxTicks(5000);
system.beforeEvents.startup.subscribe((ev) => {
  ev.customCommandRegistry.registerCommand({ name: "je2be:particleprobe", description: "Particle handler probe", permissionLevel: CommandPermissionLevel.GameDirectors }, () => {
    const tick = system.currentTick;
    const dim = world.getDimension("overworld");
    log({ event: "handler", tick, result: attempt(() => dim.spawnParticle("je2be:dust", pos, variables())) });
    system.run(() => log({ event: "deferred", tick: system.currentTick, handlerTick: tick, result: attempt(() => dim.spawnParticle("je2be:dust", pos, variables())) }));
    return { status: CustomCommandStatus.Success };
  });
});
let previousTickTime = Date.now();
system.runInterval(() => { previousTickTime = Date.now(); }, 1);
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "je2be:particle-poc") return;
  const count = Number(ev.message);
  const dim = world.getDimension("overworld");
  const player = world.getAllPlayers().find((p) => p.name === "Listener");
  const targeted = player ? attempt(() => player.spawnParticle("je2be:dust", pos, variables())) : "no player";
  const tickStart = previousTickTime;
  const start = Date.now();
  for (let i = 0; i < count; i++) {
    dim.spawnParticle("je2be:dust", { x: pos.x + (Math.random() - 0.5) * 2, y: pos.y + (Math.random() - 0.5) * 2, z: pos.z + (Math.random() - 0.5) * 2 }, variables());
  }
  const elapsedMs = Date.now() - start;
  const tick = system.currentTick;
  system.runTimeout(() => log({ event: "sample", count, targeted, elapsedMs, tick, nextTick: system.currentTick, nextMs: Date.now() - start, tickIntervalMs: Date.now() - tickStart }), 1);
});
