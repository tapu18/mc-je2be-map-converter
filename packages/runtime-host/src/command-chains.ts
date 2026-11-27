import { world } from "@minecraft/server";
import { deserializeCommandIR } from "../../core/src/command/ir-codec.ts";
import type { CommandIR } from "../../core/src/command/parser.ts";
import type { RuntimeChain, RuntimeChainBlock } from "../../core/src/runtime/command-chain.ts";
import type { ExecutionContext, Position, Rotation } from "../../core/src/runtime/context.ts";
import type { CommandResult } from "../../core/src/runtime/index.ts";
import { bedrockDimension, type RuntimeSession } from "./host.ts";

type LoadedBlock = Omit<RuntimeChainBlock, "command"> & { ir?: CommandIR };
type LoadedChain = { dimension: string; blocks: LoadedBlock[]; commands: ReadonlyMap<string, string> };

const rotations: Record<RuntimeChainBlock["facing"], Rotation> = {
  south: [0, 0], west: [90, 0], north: [180, 0], east: [-90, 0], up: [0, -90], down: [0, 90],
};

export function loadChains(data: Record<string, RuntimeChain> | undefined): Map<string, LoadedChain> {
  return new Map(Object.entries(data ?? {}).map(([id, chain]) => {
    const blocks = chain.blocks.map(({command, ...block}) => {
      if (command === undefined) return block;
      const decoded = deserializeCommandIR(command);
      if (!decoded.ok) throw Error(`chain ${id}: ${decoded.diagnostic}`);
      return {...block, ir: decoded.document.ir};
    });
    return [id, {dimension: chain.dimension, blocks, commands: new Map(chain.nativeCommands)}];
  }));
}

export function executeChain(session: RuntimeSession, chain: LoadedChain, launch: ExecutionContext): CommandResult {
  const dimension = world.getDimension(bedrockDimension(chain.dimension));
  const skipped = {success: false, error: "command block did not run"} as const;
  let previous: CommandResult = skipped;
  let head: CommandResult = skipped;
  for (const [index, block] of chain.blocks.entries()) {
    const {pos: [x, y, z], ir, native} = block;
    if (index > 0) {
      if (!dimension.isChunkLoaded({x, y, z})) break;
      const current = dimension.getBlock({x, y, z});
      if (!current || current.typeId !== "minecraft:chain_command_block") break;
      if (!block.auto && !current.getRedstonePower()) { previous = skipped; continue; }
      if (block.conditional && ("status" in previous || !previous.success)) { previous = skipped; continue; }
    }
    // Each original Java command block has its own center and orientation.
    const position: Position = [x + 0.5, y + 0.5, z + 0.5];
    const context = {...launch, position, rotation: rotations[block.facing]};
    previous = !ir ? skipped : native === undefined
      ? session.executeRestricted(ir, context, chain.commands)
      : session.deferChainCommand(ir.source, native, context);
    if (index === 0) head = previous;
    if (!("status" in previous) && !previous.success && previous.error.startsWith("unsupported")) {
      console.warn(`[je2be] chain block ${chain.dimension} ${block.pos.join(" ")}: ${previous.error}`);
    }
  }
  // The physical head's comparator observes the head command's result.
  return head;
}
