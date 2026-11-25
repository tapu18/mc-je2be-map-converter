import { world, system } from "@minecraft/server";
import { initialize } from "./initialize.ts";
import { RuntimeSession } from "./host.ts";
import { commitState } from "./persistence.ts";
import { storage } from "./storage.js";
import { objectives, entities } from "./data.js";

export let session: RuntimeSession | undefined;
world.afterEvents.worldLoad.subscribe(() => {
  initialize(objectives, entities, storage).then(state => {
    session = new RuntimeSession(state);
    const properties = {get: (key: string) => world.getDynamicProperty(key), set: (key: string, value?: string) => world.setDynamicProperty(key, value)};
    const interval = system.runInterval(() => {
      if (!session?.isConsistent) { system.clearRun(interval); console.warn("[je2be] persistence stopped: inconsistent session"); return; }
      try { commitState(properties, state); }
      catch (error) { session?.halt(); system.clearRun(interval); console.warn("[je2be] persistence failed: " + error); }
    }, 1);
  }).catch((error: unknown) => console.warn("[je2be] initialization failed: " + error));
});

// 公開された中核の入口。呼び出しとホスト実装は後続の作業で接続する。
export { executeInstruction } from "@je2be/core/runtime";
export { RuntimeSession, candidates, entity, readBlock, writeBlock, nativeCommand, readProperty, writeProperty } from "./host.ts";
export { RuntimeState } from "../../core/src/runtime/command.ts";
export { commitState, restoreState, restoreOrInitialize } from "./persistence.ts";
