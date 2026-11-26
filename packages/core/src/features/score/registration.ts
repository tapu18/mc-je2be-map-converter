import type { CommandIR } from "../../command/parser.ts";
import type { RuntimeState } from "../../runtime/command.ts";
import { entityTarget, scoreHolder, selectEntities, type ExecutionContext } from "../../runtime/context.ts";
import type { ExecutionResult } from "../../runtime/index.ts";
import { assessScore } from "./capability.ts";
import { executeScoreCommand } from "./runtime.ts";

export const scoreRuntime = {
  assess: assessScore,
  execute(state: RuntimeState, ir: CommandIR, context: ExecutionContext): ExecutionResult {
    let command = ir.command!;
    const source = command.nodes.find(node => node.name === "source");
    if (source?.value?.kind === "selector") {
      const target = entityTarget(source.value);
      if (!state.host || !target) return {success: false, error: "unsupported entity selection"};
      const entities = selectEntities(state.host, context, target, state.scores);
      if (!entities) return {success: false, error: "unsupported entity selection"};
      const [entity] = entities;
      if (!entity) return {success: false, error: "no execution targets"};
      command = {...command, nodes: command.nodes.map(node =>
        node === source ? {...node, value: {kind: "name", value: scoreHolder(entity)}} : node)};
    }
    const node = command.nodes.find(node => node.name === "target" || node.name === "targets");
    if (node?.value?.kind !== "selector") return executeScoreCommand(state.scores, command);
    if (!state.host) return {success: false, error: "unsupported command"};
    const target = entityTarget(node.value);
    const entities = target && selectEntities(state.host, context, target, state.scores);
    if (!entities) return {success: false, error: "unsupported entity selection"};
    if (!entities.length) return {success: false, error: "no execution targets"};
    if (command.nodes[1]?.name === "get" && entities.length !== 1) return {success: false, error: "expected one score holder"};
    let total = 0;
    for (const entity of entities) {
      const holder = scoreHolder(entity);
      const nodes = command.nodes.map(arg => arg === node ? {...arg, value: {kind: "name" as const, value: holder}} : arg);
      const result = executeScoreCommand(state.scores, {...command, nodes});
      if (!result.success) return result;
      total = (total + result.result) | 0;
    }
    return {success: true, result: total};
  },
};
