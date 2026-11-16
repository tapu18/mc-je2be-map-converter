// 静的な出力可否と、設計上の出力経路を別々に数える。実行成功の判定ではない。
import { rewriteCommand, toCommandIR, type RewriteContext } from "@je2be/core";

export type StaticStatus = "macro" | "unavailable" | "invalid" | "unchanged" | "rewritten" | "unsupported";
export type PlannedRoute = "native-candidate" | "runtime-required" | "unresolved";
export interface StaticVerdict {
  status: StaticStatus;
  route: PlannedRoute;
  warnings: boolean;
  /** 文法のリテラル・引数型だけ。作者が付けたIDや本文は含めない */
  pattern?: string;
}

export function staticCommandCoverage(command: string, source: "cb" | "fn", context?: RewriteContext): StaticVerdict {
  const text = command.trim();
  if (text.startsWith("$")) return { status: "macro", route: "runtime-required", warnings: false };
  if (!context) return { status: "unavailable", route: "unresolved", warnings: false };
  const parsed = context.parser.parse(text);
  if (!parsed.ok) return { status: "invalid", route: "unresolved", warnings: false };
  const result = rewriteCommand(text, context);
  if (result.status === "invalid") throw new Error("parser and rewriter disagree");
  const ir = toCommandIR(text, parsed.nodes);
  const literals = (nodes: typeof parsed.nodes): string => nodes.map(n => n.kind === "literal" ? n.name : `<${n.parser}>`).join(" ");
  const pattern = [...ir.context.map(step => `execute ${step.kind} ${literals(step.nodes)}`),
    ...(ir.command ? [`${ir.command.name} ${literals(ir.command.nodes)}`] : [])].join(" → ").trim();
  return {
    status: result.status,
    // design.md 5.4: 関数はすべてランタイム。CBはチェーン未解析なので候補に留める。
    route: source === "fn" || result.status === "unsupported" ? "runtime-required" : "native-candidate",
    warnings: result.issues.some(issue => issue.severity === "warning"),
    ...(result.status === "unsupported" ? { pattern } : {}),
  };
}
