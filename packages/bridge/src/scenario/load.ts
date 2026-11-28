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
export function loadScenarios(dir = scenariosDir): (Scenario & { id: string })[] {
  if (!existsSync(dir)) return [];
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : n.endsWith(".json") && !/\.java(?:\.\d+\.\d+(?:\.\d+)?)?\.json$/.test(n) ? [p] : [];
    });
  return walk(dir)
    .sort()
    .map((p) => {
      const s = { ...(JSON.parse(readFileSync(p, "utf8")) as Scenario), id: relative(dir, p).replace(/\.json$/, "") };
      if (s.play?.some((a) => "restart" in a) || s.bedrock?.actions?.some((a) => "restart" in a)
        || (s.actions.some((a) => "restart" in a) && !s.bedrockPending)) {
        throw new Error(`${s.id}: restart は bedrockPending の actions 専用`);
      }
      if (s.bedrockRuntime !== undefined) {
        if ((s.bedrockRuntime !== "load-tick" && s.bedrockRuntime !== "actions") || !s.datapack || (s.bedrockRuntime === "load-tick" && !s.observe.storage?.length)
          || s.bedrockPending !== undefined || s.bedrock || s.play) {
          throw new Error(`${s.id}: bedrockRuntime には datapack と observe.storage が必要。bedrockPending、bedrock、play との併用はできない`);
        }
      } else if (s.bedrockPending !== undefined) {
        if (typeof s.bedrockPending !== "string" || !s.bedrockPending.trim() || s.bedrock || s.play || s.knownDiffs) {
          throw new Error(`${s.id}: bedrockPending には理由が必要。bedrock、play、knownDiffs との併用はできない`);
        }
      } else if (s.datapack || s.observe.storage) {
        throw new Error(`${s.id}: datapack または observe.storage には bedrockPending が必要`);
      }
      return s;
    });
}

export function goldenPath(s: Scenario, dir = scenariosDir, version?: string): string {
  if (version && !/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error("Invalid Java version");
  return join(dir, `${s.id}.java${version ? `.${version}` : ""}.json`);
}

export function readGolden(s: Scenario, dir = scenariosDir, version?: string): Golden | undefined {
  const p = goldenPath(s, dir, version);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Golden) : undefined;
}

export function writeGolden(s: Scenario, golden: Golden, dir = scenariosDir, version?: string): void {
  writeFileSync(goldenPath(s, dir, version), JSON.stringify(golden, null, 2) + "\n");
}
