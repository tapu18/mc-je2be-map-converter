import { world, system } from "@minecraft/server";
import { initialize } from "./initialize.ts";
import { RuntimeSession } from "./host.ts";
import { commitState } from "./persistence.ts";
import { storage } from "./storage.js";
import * as data from "./data.js";

export let session: RuntimeSession | undefined;
world.afterEvents.worldLoad.subscribe(() => {
  initialize(data.objectives, data.entities, storage).then(state => {
    const commands = new Map(data.nativeCommands);
    session = new RuntimeSession(state, source => {
      const command = commands.get(source);
      if (command !== undefined) return {command, completion: "synchronous"};
    });
    const properties = {get: (key: string) => world.getDynamicProperty(key), set: (key: string, value?: string) => world.setDynamicProperty(key, value)};
    const interval = system.runInterval(() => {
      if (!session?.isConsistent) { system.clearRun(interval); console.warn("[je2be] persistence stopped: inconsistent session"); return; }
      try { session.syncScores(); commitState(properties, state); }
      catch (error) { session?.halt(); system.clearRun(interval); console.warn("[je2be] persistence failed: " + error); }
    }, 1);
  }).catch((error: unknown) => console.warn("[je2be] initialization failed: " + error));
});

// 公開された中核の入口。呼び出しとホスト実装は後続の作業で接続する。
export { executeInstruction } from "@je2be/core/runtime";
export { RuntimeSession, candidates, entity, readBlock, writeBlock, nativeCommand, readProperty, writeProperty } from "./host.ts";
export { RuntimeState } from "../../core/src/runtime/command.ts";
export { commitState, restoreState, restoreOrInitialize } from "./persistence.ts";
