import type { ArgumentValue } from "./arguments.ts";
import type { CommandNormalization } from "./normalize-command.ts";
import type { CommandIR, ParsedNode } from "./parser.ts";

type NormalizeArgument = (nodes: ParsedNode[], index: number, owner: string) => ArgumentValue | string | undefined;
type Failure = Extract<CommandNormalization, { ok: false }>;

/** Apply one boundary to the arguments in execution order, retaining original positions for diagnostics. */
export function normalizeArguments(ir: CommandIR, apply: NormalizeArgument): CommandNormalization {
  const normalizeNodes = (nodes: ParsedNode[], owner: string): ParsedNode[] | Failure => {
    const result: ParsedNode[] = [];
    for (const [index, node] of nodes.entries()) {
      const value = apply(nodes, index, owner);
      if (typeof value === "string") return { ok: false, reason: value, start: node.start, end: node.end };
      result.push(value && value !== node.value ? { ...node, value } : node);
    }
    return result;
  };
  const context: CommandIR["context"] = [];
  for (const step of ir.context) {
    const nodes = normalizeNodes(step.nodes, step.kind);
    if (!Array.isArray(nodes)) return nodes;
    context.push({ ...step, nodes });
  }
  if (!ir.command) return { ok: true, ir: { ...ir, context } };
  const nodes = normalizeNodes(ir.command.nodes, ir.command.name);
  if (!Array.isArray(nodes)) return nodes;
  const run = ir.command.run ? normalizeArguments(ir.command.run, apply) : undefined;
  if (run && !run.ok) return run;
  return { ok: true, ir: { ...ir, context, command: { ...ir.command, nodes, ...(run ? { run: run.ir } : {}) } } };
}
