import type { CommandIR, ParsedNode } from "./parser.ts";

/**
 * 26.2 → 26.3 の data / function / execute における座標引数名。
 * この部品だけでは他の文法差（型や値の変化）を処理しない。
 * 節の位置と値は元のコマンドに対応したまま保持する。
 */
export function normalize26_3DataArgumentNames(ir: CommandIR): CommandIR {
  const rename = (nodes: ParsedNode[]): ParsedNode[] => nodes.map(n => {
    if (n.kind !== "argument") return n;
    if (n.name === "targetPos") return { ...n, name: "target" };
    if (n.name === "sourcePos") return { ...n, name: "source" };
    return n;
  });
  const context = ir.context.map(step => {
    if (step.kind !== "if" && step.kind !== "unless" && step.kind !== "store") return step;
    const names = step.nodes.filter(n => n.kind === "literal").map(n => n.name);
    let nodes = rename(step.nodes);
    if ((step.kind === "if" || step.kind === "unless") && names[0] === "items") {
      nodes = nodes.map(n => n.kind === "argument" && (n.name === "pos" || n.name === "entities") ? { ...n, name: "source" } : n);
    }
    return { ...step, nodes };
  });
  const command = ir.command && {
    ...ir.command,
    nodes: ir.command.name === "data" || ir.command.name === "function" ? rename(ir.command.nodes) : ir.command.nodes,
    ...(ir.command.run ? { run: normalize26_3DataArgumentNames(ir.command.run) } : {}),
  };
  return command ? { ...ir, context, command } : { ...ir, context };
}
