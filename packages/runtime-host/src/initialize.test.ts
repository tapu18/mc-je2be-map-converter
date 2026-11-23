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
} }));
vi.mock("./restore.js", () => ({ restoreEntities: fake.restore }));
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
  it("途中で失敗した場合は既存のスコアを再設定せず再開する", async () => {
    fake.restore.mockRejectedValueOnce(new Error("chunk"));
    await expect(initialize([["points", [["#player", 1]]]], [])).rejects.toThrow("chunk");
    expect(fake.properties.get(INIT_PROPERTY)).toBeUndefined();
    await initialize([["points", [["#player", 1]]]], []);
    expect(fake.setScore).toHaveBeenCalledTimes(1);
    expect(fake.properties.get(INIT_PROPERTY)).toBe(true);
  });
});
