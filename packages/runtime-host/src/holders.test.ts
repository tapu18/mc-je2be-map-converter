import { beforeEach, describe, expect, it, vi } from "vitest";

type Identity = { type: "FakePlayer" | "Entity" | "Player"; displayName: string; entity?: FakeEntity };
type FakeEntity = { id: string; typeId: string; name?: string; isValid: boolean };
const fake = vi.hoisted(() => ({
  entities: new Map<string, FakeEntity>(),
  players: [] as FakeEntity[],
}));
vi.mock("@minecraft/server", () => ({
  ScoreboardIdentityType: { FakePlayer: "FakePlayer", Entity: "Entity", Player: "Player" },
  world: {
    getPlayers: () => fake.players,
    getEntity: (id: string) => fake.entities.get(id),
  },
}));
import { holderTarget, projectHolder, readScores } from "./holders.ts";

/** Scores keyed by fake-player name or by entity object, as the BE scoreboard does. */
class Objective {
  readonly id = "obj";
  readonly scores = new Map<string | FakeEntity, number>();
  private key(participant: string | FakeEntity | Identity) {
    if (typeof participant === "string") return participant;
    if ("type" in participant) return participant.entity ?? participant.displayName;
    return participant;
  }
  hasParticipant(participant: string | FakeEntity) { return this.scores.has(this.key(participant)); }
  removeParticipant(participant: string | FakeEntity) { return this.scores.delete(this.key(participant)); }
  setScore(participant: string | FakeEntity, value: number) { this.scores.set(this.key(participant), value); }
  getScore(participant: Identity) { return this.scores.get(this.key(participant)); }
  getParticipants(): (Identity & { getEntity(): FakeEntity | undefined })[] {
    return [...this.scores.keys()].map(key => typeof key === "string"
      ? {type: "FakePlayer", displayName: key, getEntity: () => undefined}
      : {type: key.typeId === "minecraft:player" ? "Player" : "Entity", displayName: key.name ?? key.typeId, entity: key, getEntity: () => { if (!key.isValid) throw Error("Failed to call function 'getEntity'"); return key; }});
  }
}
const players = () => new Map(fake.players.map(player => [player.name!, player]));
const objective = () => new Objective() as unknown as import("@minecraft/server").ScoreboardObjective & Objective;

beforeEach(() => { fake.entities.clear(); fake.players.length = 0; });

describe("holderTarget", () => {
  it("名前はオンラインのプレイヤー、ID は読み込み済みのエンティティ、それ以外は偽プレイヤーへ向ける", () => {
    const steve = {id: "-4294967295", typeId: "minecraft:player", name: "Steve", isValid: true};
    const stand = {id: "-8589934591", typeId: "minecraft:armor_stand", isValid: true};
    fake.players.push(steve); fake.entities.set(steve.id, steve); fake.entities.set(stand.id, stand);
    expect(holderTarget("Steve", players())).toEqual({kind: "entity", entity: steve});
    expect(holderTarget(stand.id, players())).toEqual({kind: "entity", entity: stand});
    // A player's entity ID is not a Java score holder; players are held by name.
    expect(holderTarget(steve.id, players())).toEqual({kind: "unavailable"});
    expect(holderTarget("Alex", players())).toEqual({kind: "fake", name: "Alex"});
    expect(holderTarget("#100", players())).toEqual({kind: "fake", name: "#100"});
    expect(holderTarget("100", players())).toEqual({kind: "fake", name: "100"});
    expect(holderTarget("-12884901887", players())).toEqual({kind: "unavailable"});
  });
});

describe("projectHolder と readScores", () => {
  it("エンティティとプレイヤーの値を実体へ書き、同名の偽プレイヤーを除き、読み戻す", () => {
    const steve = {id: "-4294967295", typeId: "minecraft:player", name: "Steve", isValid: true};
    const stand = {id: "-8589934591", typeId: "minecraft:armor_stand", isValid: true};
    fake.players.push(steve); fake.entities.set(stand.id, stand);
    const obj = objective();
    obj.setScore("Steve", 1);
    expect(projectHolder(obj, "Steve", 5, players())).toBe(true);
    expect(projectHolder(obj, stand.id, 7, players())).toBe(true);
    expect(projectHolder(obj, "#c", 3, players())).toBe(true);
    expect([...obj.scores]).toEqual([[steve, 5], [stand, 7], ["#c", 3]]);
    const scores = new Map<string, number>();
    readScores(obj, scores, players(), new Set());
    expect(Object.fromEntries(scores)).toEqual({Steve: 5, [stand.id]: 7, "#c": 3});
    expect(projectHolder(obj, stand.id, undefined, players())).toBe(true);
    expect(obj.hasParticipant(stand as never)).toBe(false);
  });
  it("未読み込みのエンティティは偽プレイヤーにせず、ランタイムの値を保つ", () => {
    const stand = {id: "-8589934591", typeId: "minecraft:armor_stand", isValid: true};
    fake.entities.set(stand.id, stand);
    const obj = objective();
    obj.setScore(stand as never, 7);
    stand.isValid = false; fake.entities.delete(stand.id);
    expect(projectHolder(obj, stand.id, 9, players())).toBe(false);
    expect(obj.hasParticipant(stand.id)).toBe(false);
    const scores = new Map([[stand.id, 9], ["gone", 1]]);
    readScores(obj, scores, players(), new Set(["obj\0" + stand.id]));
    expect(Object.fromEntries(scores)).toEqual({[stand.id]: 9});
    readScores(obj, scores, players(), new Set());
    expect(Object.fromEntries(scores)).toEqual({[stand.id]: 9});
  });
  it("プレイヤーがオンラインの間は同名の偽プレイヤーを読まない", () => {
    const steve = {id: "-4294967295", typeId: "minecraft:player", name: "Steve", isValid: true};
    fake.players.push(steve);
    const obj = objective();
    obj.setScore("Steve", 1);
    const scores = new Map([["Steve", 1]]);
    readScores(obj, scores, players(), new Set());
    expect(scores.size).toBe(0);
    fake.players.length = 0;
    readScores(obj, scores, players(), new Set());
    expect(Object.fromEntries(scores)).toEqual({Steve: 1});
  });
});
