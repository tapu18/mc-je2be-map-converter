import type { ObjectiveData, PlacedEntity } from "./types.ts";
import type { RuntimeChain } from "../../core/src/runtime/command-chain.ts";
export const objectives: ObjectiveData;
export const entities: PlacedEntity[];
export const nativeCommands: [string, string][] | undefined;
export const chains: Record<string, RuntimeChain> | undefined;
