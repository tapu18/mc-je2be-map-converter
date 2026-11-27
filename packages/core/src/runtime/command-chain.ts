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
}

export const chainLaunchPrefix = "chain@";
