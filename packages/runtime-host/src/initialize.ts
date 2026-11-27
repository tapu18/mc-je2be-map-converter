import { world } from "@minecraft/server";
import { deserializeStorage } from "../../core/src/command/ir-codec.ts";
import { RuntimeState } from "../../core/src/runtime/command.ts";
import { restoreOrInitialize } from "./persistence.ts";
import { restoreEntities } from "./restore.ts";
import { projectAllScores } from "./holders.ts";
import type { ObjectiveData, PlacedEntity } from "./types.ts";

export const INIT_PROPERTY = "je2be:initialized";
export const INIT_LOG_MARK = "[je2be] initialized";
const PROGRESS = "je2be:entity_progress";

export async function initialize(objectives: ObjectiveData, entities: PlacedEntity[], storage: {id: string; chunks: string[]}[] = []): Promise<RuntimeState> {
  const state = restoreOrInitialize({get: key => world.getDynamicProperty(key), set: (key, value) => world.setDynamicProperty(key, value)}, () => {
    const initial = new RuntimeState();
    for (const [id, scores] of objectives) {
      initial.scores.addObjective(id);
      for (const [holder, score] of scores) if (!initial.scores.set(holder, id, score)) throw Error(`invalid initial score ${id}/${holder}`);
    }
    for (const entry of storage) initial.storage.values.set(entry.id, deserializeStorage(entry.chunks.join("")));
    return initial;
  });
  projectAllScores(state);
  if (world.getDynamicProperty(INIT_PROPERTY)) return state;
  const count = objectives.reduce((total, [, scores]) => total + scores.length, 0);
  if (world.getDynamicProperty(PROGRESS) === undefined) {
    world.setDynamicProperty(PROGRESS, 0);
  }
  const failures = await restoreEntities(entities);
  world.setDynamicProperty(INIT_PROPERTY, true);
  console.warn(INIT_LOG_MARK + " " + count + " named scores, " + entities.length + " entity placements, " + failures + " entity errors");
  return state;
}
