import type { CommandIR } from "../../command/parser.ts";
import type { RuntimeState } from "../../runtime/command.ts";
import { assessScore } from "./capability.ts";
import { executeScoreCommand } from "./runtime.ts";

export const scoreRuntime = {
  assess: assessScore,
  execute(state: RuntimeState, ir: CommandIR) {
    return executeScoreCommand(state.scores, ir.command!);
  },
};
