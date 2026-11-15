// 中核パッケージの入口。Minecraft・Node固有のAPIに依存しないこと（ゲーム内のScript APIでも動かすため）。

export * from "./nbt/nbt.ts";
export * from "./bedrock/mcstructure.ts";
export * from "./java/world.ts";
export * from "./java/command-blocks.ts";
