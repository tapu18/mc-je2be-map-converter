// 中核パッケージの入口。Minecraft・Node固有のAPIに依存しないこと（ゲーム内のScript APIでも動かすため）。

export * from "./nbt/nbt.ts";
export * from "./bedrock/mcstructure.ts";
export * from "./java/world.ts";
export * from "./java/command-blocks.ts";
export * from "./mappings/mappings.ts";
export * from "./command/index.ts";

export * from "./runtime/index.ts";

export * from "./runtime/scores.ts";
export { bedrockEffect } from "./features/effect/ids.ts";
export { gameRuleByJavaName, gameRules } from "./features/game_rule/rules.ts";
export * from "./features/score/runtime.ts";
export * from "./runtime/command.ts";
export * from "./features/storage/runtime.ts";
export type { Block, ExecutionHost, Heightmap, Position, Rotation, RuntimeEntity } from "./runtime/context.ts";
export { entityTarget, resolvePosition, selectEntities } from "./runtime/context.ts";
export * from "./runtime/datapacks.ts";
export { compileModifier } from "./runtime/execute-steps.ts";
export * from "./runtime/command-chain.ts";
