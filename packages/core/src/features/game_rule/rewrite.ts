import type { ParsedNode } from "../../command/parser.ts";
import { gameRuleByJavaName } from "./rules.ts";

interface GameRuleEditor {
  replace(start: number, end: number, text: string): void;
  unsupported(message: string): void;
}

export function rewriteGameRule(nodes: ParsedNode[], ed: GameRuleEditor): void {
  const [name, value] = nodes;
  if (!name) return ed.unsupported("変換するゲームルール名を Java 側で指定する");

  const rule = gameRuleByJavaName(name.name)?.rule;
  const target = rule?.bedrock;
  const command = `gamerule ${name.name}`;
  if (!target) {
    const reason = rule?.difference ?? (rule ? "BE に対応するゲームルールがない" : "BE の対応を確認できていないゲームルール");
    return ed.unsupported(`${command}: ${reason}。Java 側でこのルールに依存する処理を見直す`);
  }

  if (target.type === "integer" && value?.value?.kind === "number") {
    const { min, max } = target;
    if (value.value.value < min || value.value.value > max) {
      return ed.unsupported(`${command}: BE で設定できる値は ${min}〜${max}。Java 側で指定値をこの範囲に収める`);
    }
  }

  if (target.type === "waypoints") {
    if (value?.value?.kind !== "bool") {
      return ed.unsupported(`${command}: BE では対応するルールの値を名前指定で照会できない。Java 側でこの照会に依存する処理を見直す`);
    }
    ed.replace(value.start, value.end, value.value.value ? "everyone" : "off");
  }

  ed.replace(name.start, name.end, target.name);
}
