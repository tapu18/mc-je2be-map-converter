import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Scenario = {
  setup: string[];
  actions: ({ run: string } | Record<string, unknown>)[];
  datapack?: { functions?: Record<string, string[]> };
};

/** A Java-recorded scenario that a Node test executes through the runtime on a fake host and compares with Java. */
export interface RuntimeScenario {
  id: string;
  /** Repository-relative test that runs the scenario. It must exist and name the scenario. */
  test: string;
  /** The command lines the test hands to the runtime, in the scenario's own text. */
  lines: (scenario: Scenario) => string[];
}

const actions = (scenario: Scenario) => scenario.actions.flatMap(action => typeof action.run === "string" ? [action.run] : []);
const functions = (scenario: Scenario) => Object.values(scenario.datapack?.functions ?? {}).flat();
// Setup, every datapack function and every command action.
const whole = (scenario: Scenario) => [...scenario.setup, ...functions(scenario), ...actions(scenario)];
const contextTest = "packages/bridge/src/runtime-context-ir.data.test.ts";
const scheduleTest = "packages/runtime-host/src/schedule.data.test.ts";
const macroTest = "packages/runtime-host/src/macro.data.test.ts";

export const runtimeScenarios: readonly RuntimeScenario[] = [
  { id: "score-operations", test: "packages/bridge/src/runtime-score-ir.data.test.ts",
    lines: scenario => [...scenario.setup, ...scenario.datapack!.functions!["m2:scores/operations"]!] },
  // The test loads no datapack, so m2:probe/noop is not exercised.
  { id: "storage-paths", test: "packages/bridge/src/runtime-storage-ir.data.test.ts", lines: scenario => [...scenario.setup, ...actions(scenario)] },
  ...["execute-context", "execute-anchor", "execute-dimension", "calls", "execute-order", "execute-order-reload", "execute-extra", "score-selector-conditions", "entity-nbt-read"]
    .map(id => ({ id, test: contextTest, lines: whole })),
  ...["schedule", "schedule-units", "schedule-day", "schedule-restart"].map(id => ({ id, test: scheduleTest, lines: whole })),
  // Macro templates ($ lines) are compiled, not parsed as a fixed shape. The test supplies
  // macro-arguments' marker and chest from fake world data instead of running these setup lines.
  ...["macro-arguments", "storage-macro"].map(id => ({ id, test: macroTest, lines: (scenario: Scenario) => whole(scenario)
    .filter(line => !line.startsWith("$") && !(id === "macro-arguments" && /^(summon marker|setblock|data merge block) /.test(line))) })),
];

/** Read each scenario's runtime lines, failing if its test was renamed or no longer names the scenario. */
export function runtimeScenarioLines(root: string, scenarios: readonly RuntimeScenario[] = runtimeScenarios): { id: string; source: string; lines: string[] }[] {
  return scenarios.map(({ id, test, lines }) => {
    const testFile = join(root, test);
    if (!existsSync(testFile)) throw new Error(`Runtime scenario ${id}: test ${test} does not exist`);
    const text = readFileSync(testFile, "utf8");
    if (!text.includes(`"${id}"`) && !text.includes(`/${id}.json`)) throw new Error(`Runtime scenario ${id}: ${test} does not name the scenario`);
    const file = `scenarios/datapack/${id}.json`;
    if (!existsSync(join(root, file))) throw new Error(`Runtime scenario ${id}: ${file} does not exist`);
    const scenario = JSON.parse(readFileSync(join(root, file), "utf8")) as Scenario;
    return { id, source: `${file}; ${test}`, lines: lines(scenario) };
  });
}
