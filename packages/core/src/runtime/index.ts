/** Host operations are synchronous: queued writes must be visible to subsequent reads. */
export interface RuntimeHost {
  hasObjective(objective: string): boolean;
  setScore(holder: string, objective: string, value: number): void;
}

/** The first supported instruction; selector expansion and other commands are future work. */
export interface ScoreSetInstruction {
  kind: "scoreboard.players.set";
  holder: string;
  objective: string;
  value: number;
}

export type RuntimeInstruction = ScoreSetInstruction;
export type ExecutionResult = { success: true; result: number } | { success: false; error: string };

/** Execute one already validated instruction against the runtime's authoritative state. */
export function executeInstruction(host: RuntimeHost, instruction: RuntimeInstruction): ExecutionResult {
  if (!Number.isInteger(instruction.value) || instruction.value < -2147483648 || instruction.value > 2147483647) {
    return { success: false, error: "score must be a signed 32-bit integer" };
  }
  if (!host.hasObjective(instruction.objective)) {
    return { success: false, error: "unknown objective" };
  }
  host.setScore(instruction.holder, instruction.objective, instruction.value);
  return { success: true, result: instruction.value };
}
