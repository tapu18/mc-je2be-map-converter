import { world, system } from "@minecraft/server";
import { datapacks } from "./datapacks.js";
import { initialize } from "./initialize.ts";
import { RuntimeSession } from "./host.ts";
import { loadDatapacks } from "../../core/src/runtime/datapacks.ts";
import { commitState, type Properties } from "./persistence.ts";
import { storage } from "./storage.js";
import * as data from "./data.js";
import { registerLauncher } from "./launcher.ts";
import { loadChains } from "./command-chains.ts";
import { runFunctionTag, startTicking } from "./loop.ts";

export let session: RuntimeSession | undefined;
let chains: ReturnType<typeof loadChains>;
registerLauncher(() => session, () => chains);
world.afterEvents.worldLoad.subscribe(() => {
  initialize(data.objectives, data.entities, storage).then(state => {
    loadDatapacks(state, datapacks);
    chains = loadChains(data.chains);
    const commands = new Map(data.nativeCommands);
    const runtime = new RuntimeSession(state, source => {
      const command = commands.get(source);
      if (command !== undefined) return {command, completion: "synchronous"};
    }, {failUndelegated: true});
    const properties: Properties = {get: key => world.getDynamicProperty(key), set: (key, value) => world.setDynamicProperty(key, value)};
    runFunctionTag(runtime, "minecraft:load");
    commitState(properties, state);
    session = runtime;
    startTicking(runtime, () => commitState(properties, state), system, message => console.warn(message));
  }).catch((error: unknown) => console.warn("[je2be] initialization failed: " + error));
});

// 公開された中核の入口。呼び出しとホスト実装は後続の作業で接続する。
export { executeInstruction } from "@je2be/core/runtime";
export { RuntimeSession, candidates, entity, readBlock, writeBlock, nativeCommand, readProperty, writeProperty } from "./host.ts";
export { RuntimeState } from "../../core/src/runtime/command.ts";
export { commitState, restoreState, restoreOrInitialize } from "./persistence.ts";
