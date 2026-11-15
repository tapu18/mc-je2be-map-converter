// ブロックの既定の状態を、Java 版サーバーのデータ生成の blocks.json から読む（Node 専用）。
// 26.x では状態がすべて既定値のブロックが状態なしで保存されるため、抽出時に補う（docs/findings.md）。
import { readFileSync } from "node:fs";
import type { BlockDefaults } from "@je2be/core";

interface BlocksReport {
  [name: string]: { properties?: Record<string, string[]>; states: { default?: boolean; properties?: Record<string, string> }[] };
}

export function loadBlockDefaults(blocksJson: string): BlockDefaults {
  const report = JSON.parse(readFileSync(blocksJson, "utf8")) as BlocksReport;
  const table = new Map<string, Record<string, string>>();
  for (const [name, b] of Object.entries(report)) {
    const d = b.states.find((s) => s.default)?.properties;
    if (d) table.set(name, d);
  }
  return (name) => table.get(name);
}
