import { world } from "@minecraft/server";
import { restoreEntities } from "./restore.js";
import type { ObjectiveData, PlacedEntity } from "./types.js";

export const INIT_PROPERTY = "je2be:initialized";
export const INIT_LOG_MARK = "[je2be] initialized";
const PROGRESS = "je2be:entity_progress";

export async function initialize(objectives: ObjectiveData, entities: PlacedEntity[]): Promise<void> {
  if (world.getDynamicProperty(INIT_PROPERTY)) return;
  const count = objectives.reduce((total, [, scores]) => total + scores.length, 0);
  if (world.getDynamicProperty(PROGRESS) === undefined) {
    for (const [id, scores] of objectives) {
      const objective = world.scoreboard.getObjective(id) ?? world.scoreboard.addObjective(id, id);
      for (const [participant, score] of scores) objective.setScore(participant, score);
    }
    world.setDynamicProperty(PROGRESS, 0);
  }
  const failures = await restoreEntities(entities);
  world.setDynamicProperty(INIT_PROPERTY, true);
  console.warn(INIT_LOG_MARK + " " + count + " named scores, " + entities.length + " entity placements, " + failures + " entity errors");
}
