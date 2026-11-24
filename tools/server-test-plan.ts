// PR の変更とテスト一覧から、実機テストの CI matrix を作る。
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { loadScenarios } from "../packages/bridge/src/scenario/load.ts";
import { repoRoot } from "../packages/bridge/src/paths.ts";
import { assign } from "./server-test-groups.ts";

const scenariosPerJob = 12;
type Quarantine = { files: Record<string, number>; scenarios: Record<string, number> };
type ServerJob = { name: string; group: string; files: string[]; scenarios: string[]; quarantine: boolean };

const scenarioId = (path: string) => /^scenarios\/(.+?)(?:\.java(?:\.\d+\.\d+(?:\.\d+)?)?)?\.json$/.exec(path)?.[1];
const pocFamily = (path: string) => /^poc\/([^/]+)\//.exec(path)?.[1];
const inert = (path: string) => path.startsWith("docs/") || /^[^/]+\.md$/.test(path);

export function planServerTests(
  groups: Record<string, string[]>,
  scenarios: string[],
  changed: string[] | undefined,
  nightly: boolean,
  quarantine: Quarantine,
): ServerJob[] {
  const scenarioFiles = groups.scenarios;
  if (scenarioFiles?.length !== 1) throw new Error("Expected one scenario suite");
  const files = Object.entries(groups).filter(([group]) => group !== "scenarios");
  for (const [entries, known] of [
    [quarantine.files, files.flatMap(([, paths]) => paths)],
    [quarantine.scenarios, scenarios],
  ] as const) {
    for (const [id, issue] of Object.entries(entries)) {
      if (!known.includes(id) || !Number.isSafeInteger(issue) || issue < 1) {
        throw new Error(`Invalid quarantine entry: ${id} (#${issue})`);
      }
    }
  }

  // 明示的に対応づけられない変更は共有コードとして扱う。
  const families = new Set(files.flatMap(([, paths]) => paths.map(pocFamily)));
  const all = changed === undefined || changed.some((path) => {
    const family = pocFamily(path);
    return !inert(path) && !scenarioId(path) && !(family && families.has(family));
  });
  const jobs: ServerJob[] = [];
  for (const isolated of nightly ? [false, true] : [false]) {
    for (const [group, paths] of files) {
      const selected = paths.filter((path) => Object.hasOwn(quarantine.files, path) === isolated
        && (all || changed?.some((edit) => pocFamily(edit) !== undefined && pocFamily(edit) === pocFamily(path))));
      if (selected.length) {
        jobs.push({ name: isolated ? `quarantine-${group}` : group, group, files: selected, scenarios: [], quarantine: isolated });
      }
    }
    const selected = scenarios.filter((id) => Object.hasOwn(quarantine.scenarios, id) === isolated
      && (all || changed?.some((path) => scenarioId(path) === id)));
    for (let start = 0; start < selected.length; start += scenariosPerJob) {
      const shard = start / scenariosPerJob + 1;
      const name = `${isolated ? "quarantine-" : ""}scenarios-${shard}`;
      jobs.push({ name, group: "scenarios", files: scenarioFiles, scenarios: selected.slice(start, start + scenariosPerJob), quarantine: isolated });
    }
  }
  return jobs;
}

function changedPaths(base: string | undefined): string[] | undefined {
  if (!base || !/^[a-f0-9]{40}$/.test(base)) return undefined;
  try {
    // R は削除と追加に分け、移動元の影響も選択に含める。
    return execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, "HEAD"], { cwd: repoRoot, encoding: "utf8" })
      .split("\0").filter(Boolean);
  } catch {
    console.warn("PR の差分を取得できなかったため、実機テストをすべて選択します。");
    return undefined;
  }
}

export function includesQuarantine(event: string | undefined, input: string | undefined): boolean {
  return event === "schedule" || (event === "workflow_dispatch" && input === "true");
}

if (import.meta.main) {
  const event = process.env.GITHUB_EVENT_NAME;
  const changed = event === "pull_request" ? changedPaths(process.env.PR_BASE_SHA) : undefined;
  const quarantine = JSON.parse(readFileSync(new URL("./server-test-quarantine.json", import.meta.url), "utf8")) as Quarantine;
  const includeQuarantine = includesQuarantine(event, process.env.INCLUDE_QUARANTINE);
  const jobs = planServerTests(assign(), loadScenarios().map(({ id }) => id), changed, includeQuarantine, quarantine);
  const matrix = JSON.stringify({ include: jobs });
  console.log(matrix);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\nhas_jobs=${jobs.length > 0}\n`);
}
