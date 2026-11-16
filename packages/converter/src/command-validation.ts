// 変換レポートに埋め込める Java 側の追加検証結果。文法パーサは変更しない。
export interface ValidationCommand {
  /** ファイル・行やブロック座標等を呼び出し元が識別できる値。 */
  id: string;
  command: string;
}

export interface JavaCheckBatch {
  checked: boolean;
  results: { command: string; ok: boolean; error?: string }[];
  contextErrors: string[];
  enabledPacks: string;
}

export type JavaDiagnosticCode = "java-unresolved-reference" | "java-invalid-id" | "java-invalid-value" | "java-invalid-command" | "java-not-checked" | "java-context-error";

export interface JavaCommandValidationReport {
  schemaVersion: 1;
  mode: "function-load";
  contextFunctions: "placeholders";
  javaVersion: string;
  /** 渡した順に記録する。サーバーには同じ順で有効化する。 */
  datapacks: string[];
  enabledPacks: string;
  /** 対象行の読み込みが完了し、パックの読み込みエラーがないこと。挙動の保証ではない。 */
  complete: boolean;
  registryValidation: "java-server";
  summary: { total: number; valid: number; invalid: number; unresolvedReferences: number; notChecked: number; contextErrors: number };
  results: { id: string; status: "valid" | "invalid" | "unresolved-reference" | "not-checked" }[];
  diagnostics: { id?: string; severity: "warning" | "info"; code: JavaDiagnosticCode; message: string }[];
}

/** 空行・コメント・マクロ・複数行を、Java で検証済みと数えない。 */
export function javaValidationSkipReason(command: string): string | undefined {
  if (/[\r\n]/.test(command)) return "複数行のコマンドはこの判定では扱えない";
  const text = command.trim();
  if (!text) return "空行";
  if (text.startsWith("#")) return "関数のコメント行";
  if (text.startsWith("$")) return "マクロは展開後のコマンドを検証する必要がある";
  if (text.endsWith("\\")) return "関数の継続行は結合してから検証する必要がある";
  return undefined;
}

/** Java 26.3 のエラーの分類。未知の表現は原文を残し一般的な拒否として扱う。 */
export function classifyJavaValidationError(error: string): JavaDiagnosticCode {
  if (/Unknown (block|item|entity_type|function) tag/.test(error)) return "java-unresolved-reference";
  const registry = /Can't find element '[^']*' (?:of type|in registry) 'minecraft:([^']+)'/.exec(error)?.[1];
  if (registry) {
    return ["attribute", "block", "item", "entity_type", "particle_type", "mob_effect", "sound_event"].includes(registry)
      ? "java-invalid-id" : "java-unresolved-reference";
  }
  if (/^Unknown (particle|block type|item|entity|attribute)/.test(error)) return "java-invalid-id";
  if (/Malformed '[^']*' component|^Can't parse particle options|^Failed to parse structure/.test(error)) return "java-invalid-value";
  return "java-invalid-command";
}

/** 検証済みの対象だけを渡し、結果の取り違え・不足を拒否する。 */
export function buildJavaValidationReport(
  commands: ValidationCommand[], batch: JavaCheckBatch, options: { javaVersion: string; datapacks?: string[] },
): JavaCommandValidationReport {
  if (new Set(commands.map((c) => c.id)).size !== commands.length) throw new Error("duplicate validation command ID");
  const eligible = commands.filter((c) => !javaValidationSkipReason(c.command));
  if (batch.checked) {
    if (batch.results.length !== eligible.length || batch.results.some((r, i) => r.command !== eligible[i]?.command)) {
      throw new Error("Java validation results do not match the input commands");
    }
  } else if (batch.results.length) throw new Error("unchecked Java batch must not contain successful verdicts");
  const report: JavaCommandValidationReport = {
    schemaVersion: 1, mode: "function-load", contextFunctions: "placeholders",
    javaVersion: options.javaVersion, datapacks: [...(options.datapacks ?? [])], enabledPacks: batch.enabledPacks,
    complete: batch.checked && batch.contextErrors.length === 0, registryValidation: "java-server",
    summary: { total: commands.length, valid: 0, invalid: 0, unresolvedReferences: 0, notChecked: 0, contextErrors: batch.contextErrors.length },
    results: [], diagnostics: [],
  };
  let index = 0;
  for (const input of commands) {
    const reason = javaValidationSkipReason(input.command) ?? (!batch.checked ? "データパックを読み込めず、コマンドを判定できなかった" : undefined);
    if (reason) {
      report.results.push({ id: input.id, status: "not-checked" });
      report.diagnostics.push({ id: input.id, severity: "info", code: "java-not-checked", message: reason });
      report.summary.notChecked++;
      report.complete = false;
      continue;
    }
    const result = batch.results[index++]!;
    if (result.ok) {
      report.results.push({ id: input.id, status: "valid" });
      report.summary.valid++;
      continue;
    }
    const message = result.error ?? "Java がコマンドを受理しなかった";
    const code = classifyJavaValidationError(message);
    report.diagnostics.push({ id: input.id, severity: "warning", code, message });
    if (code === "java-unresolved-reference") {
      report.results.push({ id: input.id, status: "unresolved-reference" });
      report.summary.unresolvedReferences++;
    } else {
      report.results.push({ id: input.id, status: "invalid" });
      report.summary.invalid++;
    }
  }
  for (const message of batch.contextErrors) report.diagnostics.push({ severity: "warning", code: "java-context-error", message });
  return report;
}
