import { entityTarget } from "../../runtime/context.ts";
import type { CapabilityInput, CapabilityResult } from "../capability.ts";
import { invalidCapability } from "../capability.ts";

/** Decide whether the score runtime supports this command's parsed form. */
export function assessScore(input: CapabilityInput): CapabilityResult {
  if (input.status === "invalid") return invalidCapability(input);
  const command = input.ir.command;
  const nodes = command?.nodes ?? [];
  const text = (name: string) => {
    const v = nodes.find(n => n.kind === "argument" && n.name === name)?.value;
    return v && (v.kind === "name" || v.kind === "word" || v.kind === "string") ? v.value : undefined;
  };
  const group = nodes[0]?.name, op = nodes[1]?.name;
  let supported = false;
  if (command?.name === "scoreboard" && group === "objectives") {
    supported = !!text("objective") && (op === "remove" || (op === "add" && text("criteria") === "dummy"));
  } else if (command?.name === "scoreboard" && group === "players") {
    const holder = text("targets") ?? text("target");
    const objective = text("objective") ?? text("targetObjective");
    const selection = nodes.find(n => n.name === "target" || n.name === "targets")?.value;
    if (selection?.kind === "selector" && entityTarget(selection)) {
      supported = !!objective && (op === "get" || ((op === "set" || op === "remove") && nodes.some(n => n.name === "score" && n.value?.kind === "number")));
    } else if (holder && holder !== "*") {
      if (op === "reset") supported = true;
      else if (objective && op === "get") supported = true;
      else if (objective && op === "operation") {
        const source = text("source"), operator = text("operation");
        const sourceTarget = entityTarget(nodes.find(n => n.name === "source")?.value);
        const self = sourceTarget?.kind === "selector" && sourceTarget.selector.variable === "s";
        supported = ((!!source && source !== "*") || self) && !!text("sourceObjective") && !!operator && ["=", "+=", "-=", "*=", "/=", "%=", "<", ">", "><"].includes(operator);
      } else if (objective && ["set", "add", "remove"].includes(op ?? "")) {
        supported = nodes.some(n => n.name === "score" && n.value?.kind === "number");
      }
    }
  }
  return { status: supported ? "runtime" : "unsupported", reason: supported ? "score runtime" : "unsupported score form", warnings: [], requiredContext: [] };
}
