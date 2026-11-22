import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyVerdicts } from "./compatibility-verdicts.ts";
import { rowKey, type Row } from "./compatibility-inventory.ts";

describe("compatibility verdict overrides", () => {
  it("survives regeneration and reports conflicting and missing keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "verdicts-"));
    try {
      const file = join(dir, "verdicts.jsonl");
      const evidence = { confidence: "unconfirmed", source: "Issue #130", scope: "test" };
      writeFileSync(file, [
        { family: "entity", id: "minecraft:pig", method: "impossible", issue: 130, evidence },
        { family: "entity", id: "minecraft:removed", evidence },
      ].map(v => JSON.stringify(v)).join("\n"));
      const machine: Row = { family: "entity", id: "minecraft:pig", javaSource: "registry", method: "rewrite", implementation: "partial", issue: 72, loss: null, evidence: { confidence: "unconfirmed", source: "probe", scope: "test" }, frequency: null };
      for (let generation = 0; generation < 2; generation++) {
        const rows = new Map([[rowKey(machine.family, machine.id), { ...machine }]]);
        const diff = applyVerdicts(rows, file);
        expect(rows.get("entity:minecraft:pig")).toMatchObject({ method: "impossible", implementation: "partial", issue: 130, evidence });
        expect(diff.conflicts[0]).toMatchObject({ key: "entity:minecraft:pig", fields: { method: { machine: "rewrite", override: "impossible" } } });
        expect(diff.missing).toMatchObject([{ family: "entity", id: "minecraft:removed" }]);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects missing evidence and duplicate keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "verdicts-"));
    try {
      const file = join(dir, "verdicts.jsonl");
      writeFileSync(file, JSON.stringify({ family: "entity", id: "x", method: "runtime" }));
      expect(() => applyVerdicts(new Map(), file)).toThrow(/Invalid verdict/);
      const line = JSON.stringify({ family: "entity", id: "x", evidence: { confidence: "estimated", source: "test", scope: "test" } });
      writeFileSync(file, `${line}\n${line}\n`);
      expect(() => applyVerdicts(new Map(), file)).toThrow(/Duplicate verdict/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
