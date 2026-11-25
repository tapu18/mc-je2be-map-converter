import { system, world } from "@minecraft/server";
import { initialize } from "./initialize.ts";
import { objectives, entities } from "./data.js";
import { datapacks } from "./datapacks.js";
import { storage } from "./storage.js";
import { deserializeStorage } from "../../core/src/command/ir-codec.ts";
import { RuntimeState } from "../../core/src/runtime/command.ts";
import { loadDatapacks } from "./load-datapacks.ts";
import { RuntimeSession } from "./host.ts";

world.afterEvents.worldLoad.subscribe(() => {
  initialize(objectives, entities).then(() => {
    // Until committed runtime generations are implemented, never silently start
    // from conversion-time data a second time and overwrite live state.
    const active = datapacks.packs.some(pack => Object.keys(pack.tags).length > 0);
    if (active && world.getDynamicProperty("je2be:runtime_started")) throw Error("runtime state restoration is not implemented; refusing to restart");
    const state = new RuntimeState();
    for (const [id, scores] of objectives) {
      state.scores.addObjective(id);
      for (const [holder, score] of scores) state.scores.set(holder, id, score);
    }
    for (const entry of storage) state.storage.values.set(entry.id, deserializeStorage(entry.chunks.join("")));
    loadDatapacks(state, datapacks);
    if (active) world.setDynamicProperty("je2be:runtime_started", true);
    const session = new RuntimeSession(state);
    const runTag = (id: string) => {
      if (!state.functionTags.has(id)) return;
      const result = session.execute({source: `function #${id}`, context: [], command: {name: "function", nodes: [{kind: "argument", name: "name", parser: "minecraft:function", start: 0, end: 0, value: {kind: "resource", id, tag: true}}]}});
      if (result.status !== "executed" || !result.projection.ok || (!result.core.success && result.core.error.startsWith("unsupported"))) throw Error(`function tag ${id}: ${JSON.stringify(result)}`);
    };
    runTag("minecraft:load");
    const interval = system.runInterval(() => {
      try { runTag("minecraft:tick"); } catch (error) { system.clearRun(interval); console.warn("[je2be] tick stopped: " + error); }
    }, 1);
  }).catch((error: unknown) => console.warn("[je2be] initialization failed: " + error));
});

export { executeInstruction } from "@je2be/core/runtime";
export { RuntimeSession, candidates, entity, readBlock, writeBlock, nativeCommand, readProperty, writeProperty } from "./host.ts";
export { RuntimeState } from "../../core/src/runtime/command.ts";
