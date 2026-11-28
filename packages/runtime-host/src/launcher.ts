import {
  CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, system,
  type Entity, type Vector3,
} from "@minecraft/server";
import type { CommandIR } from "../../core/src/command/parser.ts";
import { chainLaunchPrefix } from "../../core/src/runtime/command-chain.ts";
import { dimensionId, facingRotation, type Position } from "../../core/src/runtime/context.ts";
import { executeChain, loadChains } from "./command-chains.ts";
import type { RuntimeSession } from "./host.ts";

const positionOf = ({x, y, z}: Vector3): Position => [x, y, z];
const dimensions = new Set(["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"]);
const failure = (message: string) => ({status: CustomCommandStatus.Failure, message});

function functionCall(id: string): CommandIR {
  return {source: `function ${id}`, context: [], command: {name: "function", nodes: [
    {kind: "argument", name: "name", start: 9, end: 9 + id.length, value: {kind: "resource", id, tag: false}},
  ]}};
}

export function registerLauncher(getSession: () => RuntimeSession | undefined, getChains: () => ReturnType<typeof loadChains>): void {
  system.beforeEvents.startup.subscribe(({customCommandRegistry}) => {
    customCommandRegistry.registerCommand({
      name: "je2be:run",
      description: "Run a converted Java function or command-block chain",
      permissionLevel: CommandPermissionLevel.GameDirectors,
      mandatoryParameters: [
        {name: "function", type: CustomCommandParamType.String},
        {name: "position", type: CustomCommandParamType.Location},
        {name: "forward", type: CustomCommandParamType.Location},
        {name: "dimension", type: CustomCommandParamType.String},
      ],
      optionalParameters: [{name: "executor", type: CustomCommandParamType.EntitySelector}],
    }, (_origin, name: string, position: Vector3, forward: Vector3, dimension: string, executors?: Entity[]) => {
      const session = getSession();
      if (!session) return failure("runtime session is not ready");
      const isChain = name.startsWith(chainLaunchPrefix);
      const id = isChain || name.includes(":") ? name : `minecraft:${name}`;
      try {
        if (executors && executors.length !== 1) return failure("executor must select exactly one entity");
        const executor = executors?.[0];
        const dim = dimensionId(dimension);
        if (!dimensions.has(dim)) return failure(`unknown dimension: ${dimension}`);
        const from = positionOf(position), to = positionOf(forward);
        if (from.every((value, axis) => value === to[axis])) return failure("forward must differ from position");
        const context = {
          ...(executor && {executor: executor.id}), position: from, rotation: facingRotation(from, to),
          anchor: "feet" as const, dimension: dim,
        };
        const chain = isChain ? getChains().get(id) : undefined;
        if (isChain && (!chain || chain.dimension !== dim)) return failure(`unknown chain in ${dim}: ${id}`);
        if (chain?.deferred) {
          const queued = session.queueChain(() => {
            const result = executeChain(session, chain, context, "writable");
            if ("status" in result) console.warn(`[je2be] ${id}: unknown head outcome`);
          });
          if (queued) return "status" in queued ? failure("runtime has an unknown native outcome") : failure(queued.error);
          // The head's outcome is unknown here. Do not report success to its comparator (#236).
          return failure(`${id} runs after this tick's command blocks`);
        }
        const result = chain ? executeChain(session, chain, context) : session.executeRestricted(functionCall(id), context);
        if ("status" in result) {
          console.warn(`[je2be] je2be:run ${id}: unknown command outcome`);
          return undefined;
        }
        return result.success ? {status: CustomCommandStatus.Success} : failure(result.error);
      } catch (error) {
        return failure(String(error));
      }
    });
  });
}
