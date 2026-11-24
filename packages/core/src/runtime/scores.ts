/** Runtime-owned Java scoreboard state. Values are signed 32-bit integers. */
export class Scoreboard {
  readonly objectives = new Map<string, Map<string, number>>();

  addObjective(name: string): boolean {
    if (this.objectives.has(name)) return false;
    this.objectives.set(name, new Map());
    return true;
  }

  removeObjective(name: string): boolean { return this.objectives.delete(name); }
  get(holder: string, objective: string): number | undefined { return this.objectives.get(objective)?.get(holder); }

  set(holder: string, objective: string, value: number): boolean {
    const scores = this.objectives.get(objective);
    if (!scores || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) return false;
    scores.set(holder, value);
    return true;
  }

  reset(holder: string, objective?: string): number {
    if (objective !== undefined) return this.objectives.get(objective)?.delete(holder) ? 1 : 0;
    let count = 0;
    for (const scores of this.objectives.values()) if (scores.delete(holder)) count++;
    return count;
  }

  change(holder: string, objective: string, amount: number, subtract = false): number | undefined {
    if (!Number.isInteger(amount) || amount < 0 || amount > 2147483647 || !this.objectives.has(objective)) return undefined;
    const value = ((this.get(holder, objective) ?? 0) + (subtract ? -amount : amount)) | 0;
    this.set(holder, objective, value);
    return value;
  }

  operation(target: string, objective: string, op: ScoreOperation, source: string, sourceObjective: string): number | undefined {
    const rhs = this.get(source, sourceObjective);
    if (rhs === undefined || !this.objectives.has(objective)) return undefined;
    const lhs = this.get(target, objective) ?? 0;
    if ((op === '/=' || op === '%=') && rhs === 0) return undefined;
    let result: number;
    switch (op) {
      case '=': result = rhs; break;
      case '+=': result = (lhs + rhs) | 0; break;
      case '-=': result = (lhs - rhs) | 0; break;
      case '*=': result = Math.imul(lhs, rhs); break;
      case '/=': result = Math.floor(lhs / rhs) | 0; break;
      case '%=': result = (lhs - Math.floor(lhs / rhs) * rhs) | 0; break;
      case '<': result = Math.min(lhs, rhs); break;
      case '>': result = Math.max(lhs, rhs); break;
      case '><': result = rhs; this.set(source, sourceObjective, lhs); break;
    }
    this.set(target, objective, result);
    return result;
  }
}

export type ScoreOperation = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '<' | '>' | '><';
