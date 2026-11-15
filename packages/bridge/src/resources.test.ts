import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DirLock, freeTcpPort, freeUdpPort } from "./resources.ts";

describe("resources", () => {
  it("finds free ports", async () => {
    const [a, b] = [await freeTcpPort(), await freeUdpPort()];
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  it("refuses a lock held by a live process and releases it", () => {
    const dir = mkdtempSync(join(tmpdir(), "je2be-lock-"));
    const a = new DirLock(dir);
    a.acquire();
    expect(() => new DirLock(dir).acquire()).toThrow(/使用中/);
    a.release();
    const b = new DirLock(dir);
    b.acquire();
    b.release();
  });

  it("takes over a stale lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "je2be-lock-"));
    // 存在しないはずのpid
    writeFileSync(join(dir, ".je2be.lock"), "2147483646");
    const lock = new DirLock(dir);
    lock.acquire();
    lock.release();
  });
});
