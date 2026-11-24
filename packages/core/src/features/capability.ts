import type { CommandIR } from "../command/parser.ts";

/** 構文エラーは parser が返す。成功時だけ族の判定に IR を渡す。 */
export type CapabilityInput =
  | { status: "parsed"; ir: CommandIR }
  | { status: "invalid"; message: string; position: number };

/** 警告は表示順、context は実行に必要な文脈の名前。 */
export type CapabilityResult<T = undefined> =
  | { status: "invalid"; reason: string; position: number; warnings: string[]; requiredContext: string[] }
  | { status: "native"; reason: string; warnings: string[]; requiredContext: string[]; value: T }
  | { status: "runtime" | "unsupported"; reason: string; warnings: string[]; requiredContext: string[] };

export function invalidCapability(input: Extract<CapabilityInput, { status: "invalid" }>): CapabilityResult<never> {
  return { status: "invalid", reason: input.message, position: input.position, warnings: [], requiredContext: [] };
}
