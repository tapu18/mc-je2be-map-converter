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
