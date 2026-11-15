import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDataPack, jsonLines, relativeOrder, tickOrders, waitForLog } from "./poc-kit.ts";

describe("poc kit", () => {
  it("reads prefixed JSON lines", () => {
    const log = ["[INFO] [Scripting] POC {\"a\":1}", "noise", "POC_DP {\"x\":2}", "[x] POC {\"a\":3}"];
    expect(jsonLines(log, "POC")).toEqual([{ a: 1 }, { a: 3 }]);
    expect(jsonLines(log, "POC_DP")).toEqual([{ x: 2 }]);
    expect(jsonLines(log, "POC", 1)).toEqual([{ a: 3 }]);
  });

  it("waits for a log line", async () => {
    const log: string[] = [];
    setTimeout(() => log.push("hello DONE"), 30);
    await expect(waitForLog(log, (l) => l.includes("DONE"), 1000)).resolves.toBe("hello DONE");
    await expect(waitForLog(log, (l) => l.includes("never"), 100)).rejects.toThrow(/timeout/);
  });

  it("summarizes per-tick orders and drops partial first/last ticks", () => {
    const marks = [
      { tick: 1, source: "b" },
      ...[2, 3, 4].flatMap((t) => [{ tick: t, source: "a" }, { tick: t, source: "b" }, { tick: t, source: "a.run" }]),
      { tick: 5, source: "b" }, { tick: 5, source: "a" },
      { tick: 6, source: "a" },
    ];
    const s = tickOrders(marks, (src) => !src.endsWith(".run"));
    expect(s).toEqual({ ticks: 4, orders: [{ order: ["a", "b"], count: 3 }, { order: ["b", "a"], count: 1 }] });
    expect(relativeOrder(s, "a", "b")).toBe("varies");
    expect(relativeOrder(tickOrders(marks.filter((m) => m.tick !== 5)), "a", "b")).toBe("before");
  });

  it("creates a data-only behavior pack with structures", () => {
    const dir = createDataPack({ s1: new Uint8Array([1, 2, 3]) });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { modules: { type: string }[] };
    expect(manifest.modules[0]!.type).toBe("data");
    expect(existsSync(join(dir, "structures", "je2be", "s1.mcstructure"))).toBe(true);
  });
});
