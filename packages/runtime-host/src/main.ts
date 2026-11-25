import { world } from "@minecraft/server";
import { initialize } from "./initialize.ts";
import { objectives, entities } from "./data.js";

world.afterEvents.worldLoad.subscribe(() => {
  initialize(objectives, entities).catch((error: unknown) => console.warn("[je2be] initialization failed: " + error));
});

// 公開された中核の入口。呼び出しとホスト実装は後続の作業で接続する。
export { executeInstruction } from "@je2be/core/runtime";
export { RuntimeSession, candidates, entity, readBlock, writeBlock, nativeCommand, readProperty, writeProperty } from "./host.ts";
export { RuntimeState } from "../../core/src/runtime/command.ts";
export { commitState, restoreState, restoreOrInitialize } from "./persistence.ts";
