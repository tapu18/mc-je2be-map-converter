import type { CommandIR, ParsedNode } from "../command/parser.ts";
import { Scoreboard, type ScoreOperation } from "./scores.ts";
import type { ExecutionResult } from "./index.ts";

const fail = (error: string): ExecutionResult => ({ success: false, error });
const ok = (result: number): ExecutionResult => ({ success: true, result });
const text = (nodes: ParsedNode[], name: string): string | undefined => {
  const v = nodes.find(n => n.kind === "argument" && n.name === name)?.value;
  return v && (v.kind === "name" || v.kind === "word" || v.kind === "string") ? v.value : undefined;
};
const number = (nodes: ParsedNode[], name: string): number | undefined => {
  const v = nodes.find(n => n.kind === "argument" && n.name === name)?.value;
  return v?.kind === "number" ? v.value : undefined;
};

/** Execute the single-holder scoreboard forms. Other forms fail explicitly. */
export function executeScoreCommand(scores: Scoreboard, command: NonNullable<CommandIR["command"]>): ExecutionResult {
  if (command.name !== "scoreboard") return fail("unsupported command");
  const nodes = command.nodes;
  const group = nodes[0]?.name, op = nodes[1]?.name;
  if (group === "objectives") {
    const objective = text(nodes, "objective");
    if (!objective) return fail("unsupported objective");
    if (op === "add" && text(nodes, "criteria") === "dummy") return scores.addObjective(objective) ? ok(1) : fail("objective exists");
    if (op === "remove") return scores.removeObjective(objective) ? ok(1) : fail("unknown objective");
    return fail("unsupported objective operation");
  }
  if (group !== "players") return fail("unsupported scoreboard operation");
  const holder = text(nodes, "targets") ?? text(nodes, "target");
  const objective = text(nodes, "objective") ?? text(nodes, "targetObjective");
  if (!holder || holder === "*") return fail("unsupported score holder");
  if (op === "reset") { const count = scores.reset(holder, objective); return count ? ok(count) : fail("score missing"); }
  if (!objective) return fail("missing objective");
  if (op === "get") { const value = scores.get(holder, objective); return value === undefined ? fail("score missing") : ok(value); }
  if (op === "operation") {
    const source = text(nodes, "source"), sourceObjective = text(nodes, "sourceObjective"), operator = text(nodes, "operation");
    if (!source || source === "*" || !sourceObjective || !operator || !["=", "+=", "-=", "*=", "/=", "%=", "<", ">", "><"].includes(operator)) return fail("unsupported score operation");
    const result = scores.operation(holder, objective, operator as ScoreOperation, source, sourceObjective);
    return result === undefined ? fail("score operation failed") : ok(result);
  }
  const value = number(nodes, "score");
  if (value === undefined) return fail("missing score");
  if (op === "set") return scores.set(holder, objective, value) ? ok(value) : fail("score set failed");
  if (op === "add" || op === "remove") {
    const result = scores.change(holder, objective, value, op === "remove");
    return result === undefined ? fail("score change failed") : ok(result);
  }
  return fail("unsupported player operation");
}
