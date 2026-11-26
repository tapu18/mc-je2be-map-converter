import { world, system } from "@minecraft/server";
import type { CommandIR } from "../../core/src/command/parser.ts";
import { scheduledFunctionCalls } from "../../core/src/runtime/command.ts";
import { datapacks } from "./datapacks.js";
import { initialize } from "./initialize.ts";
import { RuntimeSession } from "./host.ts";
import { loadDatapacks } from "./load-datapacks.ts";
import { commitState, type Properties } from "./persistence.ts";
import { storage } from "./storage.js";
import * as data from "./data.js";
import { registerLauncher } from "./launcher.ts";

export let session: RuntimeSession | undefined;
registerLauncher(() => session);
world.afterEvents.worldLoad.subscribe(() => {
  initialize(data.objectives, data.entities, storage).then(state => {
    loadDatapacks(state, datapacks);
    const commands = new Map(data.nativeCommands);
    const runtime = new RuntimeSession(state, source => {
      const command = commands.get(source);
      if (command !== undefined) return {command, completion: "synchronous"};
    });
    const properties: Properties = {get: key => world.getDynamicProperty(key), set: (key, value) => world.setDynamicProperty(key, value)};
    const execute = (ir: CommandIR) => {
      const result = runtime.execute(ir);
      if (result.status !== "executed" || !result.projection.ok || "status" in result.core) {
        throw Error(`${ir.source}: ${JSON.stringify(result)}`);
      }
      if (!result.core.success && (result.core.error.startsWith("unsupported") || result.core.error.endsWith("budget exceeded"))) {
        throw Error(`${ir.source}: ${result.core.error}`);
      }
    };
    const runTag = (id: string) => {
      if (!state.functionTags.has(id)) return;
      const source = `function #${id}`;
      execute({source, context: [], command: {name: "function", nodes: [
        {kind: "argument", name: "name", start: 9, end: source.length, value: {kind: "resource", id, tag: true}},
      ]}});
    };
    runTag("minecraft:load");
    commitState(properties, state);
    session = runtime;
    const interval = system.runInterval(() => {
      try {
        runtime.syncScores();
        // Project pending launcher scores before schedule and the tick tag.
        if (state.functions.size) for (const {ir} of scheduledFunctionCalls(state)) execute(ir);
        runTag("minecraft:tick");
        commitState(properties, state);
      } catch (error) {
        runtime.halt();
        system.clearRun(interval);
        console.warn("[je2be] tick stopped: " + error);
      }
    }, 1);
  }).catch((error: unknown) => console.warn("[je2be] initialization failed: " + error));
});

// 公開された中核の入口。呼び出しとホスト実装は後続の作業で接続する。
export { executeInstruction } from "@je2be/core/runtime";
export { RuntimeSession, candidates, entity, readBlock, writeBlock, nativeCommand, readProperty, writeProperty } from "./host.ts";
export { RuntimeState } from "../../core/src/runtime/command.ts";
export { commitState, restoreState, restoreOrInitialize } from "./persistence.ts";
