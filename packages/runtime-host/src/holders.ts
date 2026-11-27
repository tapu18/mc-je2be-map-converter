import { ScoreboardIdentityType, world, type Entity, type Player, type ScoreboardIdentity, type ScoreboardObjective } from "@minecraft/server";
import type { RuntimeState } from "../../core/src/runtime/command.ts";

/**
 * The BE score target for a runtime holder. Runtime holders are player names and
 * non-player entity IDs (`scoreHolder`). An online player or a loaded entity receives
 * the score on its own scoreboard identity; other names stay fake players. A numeric
 * holder outside the 32-bit range is taken as the ID of an unloaded entity: it never
 * becomes a fake player and its projection waits until the entity is loaded.
 */
export type HolderTarget = { kind: "entity"; entity: Entity } | { kind: "fake"; name: string } | { kind: "unavailable" };
const int32 = (holder: string) => { const value = Number(holder); return value >= -2147483648 && value <= 2147483647; };
export function holderTarget(holder: string, players = onlinePlayers()): HolderTarget {
  const player = players.get(holder);
  if (player?.isValid) return {kind: "entity", entity: player};
  if (!/^-?\d+$/.test(holder)) return {kind: "fake", name: holder};
  let found: Entity | undefined;
  try { found = world.getEntity(holder); } catch { found = undefined; }
  if (found?.isValid && found.typeId !== "minecraft:player") return {kind: "entity", entity: found};
  return int32(holder) ? {kind: "fake", name: holder} : {kind: "unavailable"};
}
export function onlinePlayers(): Map<string, Player> { return new Map(world.getPlayers().map(player => [player.name, player])); }
const identityHolder = (entity: Entity) => entity.typeId === "minecraft:player" ? (entity as Player).name : entity.id;

/** Write one runtime value (or its absence) to the holder's BE target. */
export function projectHolder(objective: ScoreboardObjective, holder: string, value: number | undefined, players: Map<string, Player>): boolean {
  const target = holderTarget(holder, players);
  if (target.kind === "unavailable") return false;
  // A player name may also exist as a fake player (projected while the player was offline).
  if (target.kind === "entity" && objective.hasParticipant(holder)) objective.removeParticipant(holder);
  const participant = target.kind === "entity" ? target.entity : target.name;
  if (value === undefined) {
    if (objective.hasParticipant(participant) && !objective.removeParticipant(participant)) throw Error("score missing");
  } else objective.setScore(participant, value);
  return true;
}

/** Project every runtime score at startup. Unloaded entities keep the score BE saved for them. */
export function projectAllScores(state: RuntimeState): void {
  const players = onlinePlayers();
  for (const [id, scores] of state.scores.objectives) {
    const objective = world.scoreboard.getObjective(id) ?? world.scoreboard.addObjective(id, id);
    for (const [holder, score] of scores) projectHolder(objective, holder, score, players);
  }
}

/**
 * Read BE scores back into the runtime map. Fake players, loaded entities and online
 * players are observable; a holder whose target is unavailable (an unloaded entity) or
 * whose projection is still deferred keeps its runtime value.
 */
export function readScores(objective: ScoreboardObjective, scores: Map<string, number>, players: Map<string, Player>, deferred: Set<string>): void {
  const observed = new Map<string, number>();
  const fakes: [string, ScoreboardIdentity][] = [];
  for (const participant of objective.getParticipants()) {
    if (participant.type === ScoreboardIdentityType.FakePlayer) { fakes.push([participant.displayName, participant]); continue; }
    // getEntity throws for an entity that is not loaded (BDS 1.26.66.1).
    let entity: Entity | undefined;
    try { entity = participant.getEntity(); } catch { continue; }
    if (!entity?.isValid) continue;
    const value = objective.getScore(participant);
    if (value !== undefined) observed.set(identityHolder(entity), value);
  }
  // A fake player shadowed by an online player or loaded entity of the same holder is ignored.
  for (const [name, participant] of fakes) if (!observed.has(name) && holderTarget(name, players).kind === "fake") {
    const value = objective.getScore(participant);
    if (value !== undefined) observed.set(name, value);
  }
  const keep = (holder: string) => deferred.has(`${objective.id}\0${holder}`) || holderTarget(holder, players).kind === "unavailable";
  for (const holder of [...scores.keys()]) if (!observed.has(holder) && !keep(holder)) scores.delete(holder);
  for (const [holder, value] of observed) if (!deferred.has(`${objective.id}\0${holder}`)) scores.set(holder, value);
}
