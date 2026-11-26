import {
  CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, system,
  type Entity, type Vector3,
} from "@minecraft/server";
import type { CommandIR } from "../../core/src/command/parser.ts";
import { deserializeCommandIR } from "../../core/src/command/ir-codec.ts";
import { dimensionId, facingRotation, type Position } from "../../core/src/runtime/context.ts";
import { datapacks } from "./datapacks.js";
import type { RuntimeSession } from "./host.ts";

const positionOf = ({x, y, z}: Vector3): Position => [x, y, z];
const dimensions = new Set(["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"]);
const failure = (message: string) => ({status: CustomCommandStatus.Failure, message});

function functionCall(id: string): CommandIR {
  return {source: `function ${id}`, context: [], command: {name: "function", nodes: [
    {kind: "argument", name: "name", start: 9, end: 9 + id.length, value: {kind: "resource", id, tag: false}},
  ]}};
}

function loadFunctions(session: RuntimeSession): void {
  if (datapacks.schemaVersion !== 1) throw Error("unsupported datapack schema");
  for (const pack of datapacks.packs) {
    for (const [id, lines] of Object.entries(pack.functions)) {
      const commands = lines.map(line => deserializeCommandIR(line));
      if (commands.every(command => command.ok)) {
        session.state.functions.set(id, commands.map(command => command.document.ir));
      } else {
        session.state.functions.delete(id);
        console.warn(`[je2be] invalid function IR: ${id}`);
      }
    }
  }
}

export function registerLauncher(getSession: () => RuntimeSession | undefined): void {
  let loadedSession: RuntimeSession | undefined;
  system.beforeEvents.startup.subscribe(({customCommandRegistry}) => {
    customCommandRegistry.registerCommand({
      name: "je2be:run",
      description: "Run a converted Java function",
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
      const id = name.includes(":") ? name : `minecraft:${name}`;
      try {
        if (executors && executors.length !== 1) return failure("executor must select exactly one entity");
        const executor = executors?.[0];
        const dim = dimensionId(dimension);
        if (!dimensions.has(dim)) return failure(`unknown dimension: ${dimension}`);
        const from = positionOf(position), to = positionOf(forward);
        if (from.every((value, axis) => value === to[axis])) return failure("forward must differ from position");
        if (loadedSession !== session) {
          loadFunctions(session);
          loadedSession = session;
        }
        const result = session.executeRestricted(functionCall(id), {
          ...(executor && {executor: executor.id}), position: from, rotation: facingRotation(from, to),
          anchor: "feet", dimension: dim,
        });
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
