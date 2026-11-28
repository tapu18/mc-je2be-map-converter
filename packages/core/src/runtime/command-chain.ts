import type { JavaFacing } from "../java/command-blocks.ts";
import type { Position } from "./context.ts";

export interface RuntimeChainBlock {
  pos: Position;
  facing: JavaFacing;
  conditional: boolean;
  auto: boolean;
  command?: string;
  /** Full BE command when the runtime cannot evaluate the Java execute context. */
  native?: string;
}

export interface RuntimeChain {
  dimension: string;
  blocks: RuntimeChainBlock[];
  /** Terminal BE commands delegated by command blocks, keyed by the Java source. */
  nativeCommands: [string, string][];
  /**
   * Run the whole chain after this tick's command blocks, where delegated commands report BE's
   * `successCount` to later conditional blocks (#93 decision 2). The launching block cannot observe the result.
   */
  deferred?: true;
}

export const chainLaunchPrefix = "chain@";
