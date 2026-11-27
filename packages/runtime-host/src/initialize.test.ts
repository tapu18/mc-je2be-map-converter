import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  properties: new Map<string, unknown>(),
  setScore: vi.fn(),
  addObjective: vi.fn(),
  getObjective: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@minecraft/server", () => ({ world: {
  getDynamicProperty: (key: string) => fake.properties.get(key),
  setDynamicProperty: (key: string, value: unknown) => fake.properties.set(key, value),
  scoreboard: { getObjective: fake.getObjective, addObjective: fake.addObjective },
  getPlayers: () => [],
  getEntity: () => undefined,
} }));
vi.mock("./restore.ts", () => ({ restoreEntities: fake.restore }));
import { serializeStorage } from "../../core/src/command/ir-codec.ts";
import { initialize, INIT_PROPERTY } from "./initialize.ts";

beforeEach(() => {
  fake.properties.clear();
  vi.clearAllMocks();
  fake.getObjective.mockReturnValue(undefined);
  fake.addObjective.mockReturnValue({ setScore: fake.setScore });
  fake.restore.mockResolvedValue(0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("initialize", () => {
  it("スコアとエンティティを復元し、完了後は再実行しない", async () => {
    await initialize([["points", [["#player", -3]]]], []);
    expect(fake.addObjective).toHaveBeenCalledWith("points", "points");
    expect(fake.setScore).toHaveBeenCalledWith("#player", -3);
    expect(fake.restore).toHaveBeenCalledWith([]);
    expect(fake.properties.get(INIT_PROPERTY)).toBe(true);
    await initialize([["points", [["#player", -3]]]], []);
    expect(fake.restore).toHaveBeenCalledTimes(1);
  });
  it("初期 storage を取り込み、次回は確定した値を使う", async () => {
    const value = {type: "compound" as const, value: new Map([["name", {type: "string" as const, value: "initial"}]])};
    const first = await initialize([["points", [["alice", 3]]]], [], [{id: "test:data", chunks: [serializeStorage(value)]}]);
    expect(first.storage.get("test:data")).toEqual(value);
    const restored = await initialize([["points", [["alice", 99]]]], [], []);
    expect(restored.scores.get("alice", "points")).toBe(3);
    expect(restored.storage.get("test:data")).toEqual(value);
  });
  it("途中で失敗した場合は既存のスコアを再設定せず再開する", async () => {
    fake.restore.mockRejectedValueOnce(new Error("chunk"));
    await expect(initialize([["points", [["#player", 1]]]], [])).rejects.toThrow("chunk");
    expect(fake.properties.get(INIT_PROPERTY)).toBeUndefined();
    await initialize([["points", [["#player", 1]]]], []);
    expect(fake.setScore).toHaveBeenCalledTimes(2);
    expect(fake.properties.get(INIT_PROPERTY)).toBe(true);
  });
});
