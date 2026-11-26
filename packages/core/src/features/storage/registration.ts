import type { CommandIR } from "../../command/parser.ts";
import type { RuntimeState } from "../../runtime/command.ts";
import { assessStorage } from "./capability.ts";
import { executeStorageCommand } from "./runtime.ts";

export const storageRuntime = {
  assess: assessStorage,
  execute(state: RuntimeState, ir: CommandIR) {
    return executeStorageCommand(state.storage, ir.command!);
  },
};
