// scenarios/ のシナリオと正解データの読み書き。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../paths.ts";
import type { NormalizedState, Scenario } from "./types.ts";

export const scenariosDir = join(repoRoot, "scenarios");

export interface Golden {
  /** 記録に使った Java 版サーバー */
  java: string;
  state: NormalizedState;
}

/** scenarios/ 以下のシナリオを読む。id は scenarios/ からの相対パス（拡張子なし） */
export function loadScenarios(dir = scenariosDir): Scenario[] {
  if (!existsSync(dir)) return [];
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : n.endsWith(".json") && !n.endsWith(".java.json") ? [p] : [];
    });
  return walk(dir)
    .sort()
    .map((p) => ({ ...(JSON.parse(readFileSync(p, "utf8")) as Scenario), id: relative(dir, p).replace(/\.json$/, "") }));
}

export function goldenPath(s: Scenario, dir = scenariosDir): string {
  return join(dir, `${s.id}.java.json`);
}

export function readGolden(s: Scenario, dir = scenariosDir): Golden | undefined {
  const p = goldenPath(s, dir);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Golden) : undefined;
}

export function writeGolden(s: Scenario, golden: Golden, dir = scenariosDir): void {
  writeFileSync(goldenPath(s, dir), JSON.stringify(golden, null, 2) + "\n");
}
