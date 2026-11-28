import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NbtTag } from "@je2be/core";
import { nbtToPlain } from "@je2be/core";
import { javaGrammarSources, setupJavaGrammar } from "@je2be/converter";
import { BedrockServer } from "../bedrock.ts";
import { buildConvertedWorld } from "./run.ts";
import type { NormalizedState, Scenario } from "./types.ts";

const SNAPSHOT = "JE2BE_LOAD_TICK ";
type Snapshot = { scores: NonNullable<NormalizedState["scores"]>; storage: Record<string, NbtTag> };

/** BDS keeps ticking between bridge requests. Sample the committed state in the server at the requested tick. */
export async function runBedrockLoadTick(scenario: Scenario, javaVersion: string): Promise<{ state: NormalizedState; log: string[] }> {
  const log: string[] = [];
  const action = scenario.actions.at(-1);
  if (!action || !("ticks" in action)) throw Error("load-tick must end with a tick step");
  const grammar = javaGrammarSources().find(source => source.version === javaVersion);
  if (!grammar) throw Error("fixed Java grammar source missing");
  await setupJavaGrammar(grammar);
  const converted = await buildConvertedWorld({...scenario, actions: scenario.actions.slice(0, -1)}, log);
  try {
    if (converted.report.datapacks.diagnostics.length) throw Error(log.join("\n"));
    const scripts = join(converted.world, "behavior_packs", "je2be_init", "scripts");
    const main = join(scripts, "main.js");
    // Observe inside the converter's pack so the probe can access its session and dynamic properties.
    writeFileSync(join(scripts, "runtime.js"), readFileSync(main));
    writeFileSync(main, `
import { system, world } from "@minecraft/server";
import { restoreState, session } from "./runtime.js";
const probe = system.runInterval(() => {
  if (session?.state.schedule.tick !== ${JSON.stringify(action.ticks)}) return;
  system.clearRun(probe);
  const committed = restoreState({get: key => world.getDynamicProperty(key)});
  if (committed.schedule.tick !== session.state.schedule.tick) throw Error("uncommitted tick");
  const scores = Object.fromEntries(${JSON.stringify(scenario.observe.scores ?? [])}.map(id => {
    const objective = world.scoreboard.getObjective(id);
    return [id, Object.fromEntries(objective.getScores().map(row => [row.participant.displayName, row.score]))];
  }));
  const storage = Object.fromEntries(${JSON.stringify(scenario.observe.storage ?? [])}.map(id => [id, committed.storage.get(id)]));
  console.warn(${JSON.stringify(SNAPSHOT)} + JSON.stringify({scores, storage},
    (_key, value) => value instanceof Map ? {entries: [...value]} : value));
}, 1);
`);
    const bds = await BedrockServer.start({world: converted.world, worldSettings: "preserve"});
    try {
      const line = await bds.waitForLog(l => l.includes(SNAPSHOT), 30_000, "load-tick snapshot");
      const snapshot = JSON.parse(line.slice(line.indexOf(SNAPSHOT) + SNAPSHOT.length),
        (_key, value) => value?.entries && Array.isArray(value.entries) ? new Map(value.entries) : value) as Snapshot;
      return {
        state: {
          scores: snapshot.scores,
          storage: Object.fromEntries(Object.entries(snapshot.storage).map(([id, tag]) => [id, nbtToPlain(tag)])),
        },
        log: [...log, line],
      };
    } finally {
      await bds.stop();
    }
  } finally {
    rmSync(converted.work, {recursive: true, force: true});
  }
}

const ACTIONS_SNAPSHOT = "JE2BE_ACTIONS ";
const ACTION_NAMESPACE = "je2be_scenario";
type RuntimeStep = { run: string } | { ticks: number };

/**
 * BE has no RCON-equivalent way to run Java commands through the runtime. Each `run` action becomes a
 * function in a scenario-only namespace, so the converter rewrites it like any datapack function.
 * The probe calls those functions from a writable tick at the same schedule tick as Java's frozen gap.
 */
export async function runBedrockRuntimeActions(scenario: Scenario, javaVersion: string): Promise<{ state: NormalizedState; log: string[] }> {
  const log: string[] = [];
  const steps: RuntimeStep[] = scenario.actions.map((action, index) => {
    if ("run" in action) return {run: `${ACTION_NAMESPACE}:action/${index}`};
    if ("ticks" in action) return action;
    throw Error(`${scenario.id}: bedrockRuntime "actions" supports only run and ticks`);
  });
  const functions = Object.fromEntries(scenario.actions.flatMap((action, index) =>
    "run" in action ? [[`${ACTION_NAMESPACE}:action/${index}`, [action.run]]] : []));
  const grammar = javaGrammarSources().find(source => source.version === javaVersion);
  if (!grammar) throw Error("fixed Java grammar source missing");
  await setupJavaGrammar(grammar);
  const converted = await buildConvertedWorld({
    ...scenario, actions: [],
    datapack: {...scenario.datapack, functions: {...scenario.datapack?.functions, ...functions}},
  }, log);
  try {
    if (converted.report.datapacks.diagnostics.length) throw Error(log.join("\n"));
    const scripts = join(converted.world, "behavior_packs", "je2be_init", "scripts");
    const main = join(scripts, "main.js");
    writeFileSync(join(scripts, "runtime.js"), readFileSync(main));
    writeFileSync(main, `
import { system, world } from "@minecraft/server";
import { session } from "./runtime.js";
const steps = ${JSON.stringify(steps)};
const call = id => {
  const source = "function " + id;
  return {source, context: [], command: {name: "function", nodes: [
    {kind: "argument", name: "name", start: 9, end: source.length, value: {kind: "resource", id, tag: false}},
  ]}};
};
let step = 0, due;
const unsupported = [];
const probe = system.runInterval(() => {
  if (!session) return;
  // schedule.tick advances only in the runtime's tick, so this is the gap after that tick in either callback order.
  const tick = session.state.schedule.tick;
  try {
    while (step < steps.length) {
      const current = steps[step];
      if ("ticks" in current) {
        due ??= tick + current.ticks;
        if (tick < due) return;
        due = undefined;
      } else {
        const result = session.execute(call(current.run));
        if (result.status !== "executed" || !result.projection.ok || "status" in result.core
          || (!result.core.success && result.core.error.endsWith("budget exceeded"))) {
          throw Error(current.run + ": " + JSON.stringify(result));
        }
        // An unsupported command fails like any other; its effect must show up as a recorded difference.
        if (!result.core.success && result.core.error.startsWith("unsupported")) unsupported.push(current.run);
        console.warn("[je2be-scenario] " + current.run + " " + JSON.stringify(result.core));
      }
      step++;
    }
    system.clearRun(probe);
    session.syncScores();
    const scores = Object.fromEntries(${JSON.stringify(scenario.observe.scores ?? [])}.map(id => {
      const objective = world.scoreboard.getObjective(id);
      return [id, Object.fromEntries((objective?.getScores() ?? []).map(row => [row.participant.displayName, row.score]))];
    }));
    const storage = Object.fromEntries(${JSON.stringify(scenario.observe.storage ?? [])}.map(id => [id, session.state.storage.get(id)]));
    console.warn(${JSON.stringify(ACTIONS_SNAPSHOT)} + JSON.stringify({scores, storage, unsupported},
      (_key, value) => value instanceof Map ? {entries: [...value]} : value));
  } catch (error) {
    system.clearRun(probe);
    console.warn(${JSON.stringify(ACTIONS_SNAPSHOT)} + JSON.stringify({error: String(error)}));
  }
}, 1);
`);
    const bds = await BedrockServer.start({world: converted.world, worldSettings: "preserve"});
    try {
      const line = await bds.waitForLog(l => l.includes(ACTIONS_SNAPSHOT), 60_000, "actions snapshot");
      const snapshot = JSON.parse(line.slice(line.indexOf(ACTIONS_SNAPSHOT) + ACTIONS_SNAPSHOT.length),
        (_key, value) => value?.entries && Array.isArray(value.entries) ? new Map(value.entries) : value) as (Snapshot & {unsupported: string[]}) | {error: string};
      if ("error" in snapshot) throw Error(`bedrock runtime actions: ${snapshot.error}\n${log.join("\n")}`);
      const state: NormalizedState = {};
      if (scenario.observe.scores) state.scores = snapshot.scores;
      if (scenario.observe.storage) {
        state.storage = Object.fromEntries(Object.entries(snapshot.storage).map(([id, tag]) => [id, tag === undefined ? undefined : nbtToPlain(tag)]));
      }
      if (snapshot.unsupported.length) console.log(`${scenario.id}: BE ランタイムが未対応として失敗した操作\n  ${snapshot.unsupported.map(id => `${id}: ${functions[id]![0]}`).join("\n  ")}`);
      return {state, log: [...log, line]};
    } finally {
      await bds.stop();
    }
  } finally {
    rmSync(converted.work, {recursive: true, force: true});
  }
}
