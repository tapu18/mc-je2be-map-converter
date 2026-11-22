import { readFileSync } from "node:fs";
import { methods, registries, rowKey, type Family, type Row, type Verdict } from "./compatibility-inventory.ts";

type Override = { family: Family; id: string; evidence: Verdict["evidence"] } & Partial<Omit<Verdict, "evidence">>;
const fields = ["method", "implementation", "issue", "loss", "evidence"] as const;

export function applyVerdicts(rows: Map<string, Row>, file: string) {
  const seen = new Set<string>();
  const missing: Override[] = [];
  const conflicts: { key: string; fields: Record<string, { machine: unknown; override: unknown }> }[] = [];
  for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const value: unknown = JSON.parse(line);
    const fail = () => { throw new Error(`Invalid verdict at ${file}:${index + 1}`); };
    if (!value || typeof value !== "object" || Array.isArray(value)) { fail(); continue; }
    const v = value as Record<string, unknown>;
    const families = [...Object.keys(registries), "command", "click", "hover"];
    if (typeof v.family !== "string" || !families.includes(v.family) || typeof v.id !== "string" || !v.id.trim() ||
        Object.keys(v).some(k => !["family", "id", ...fields].includes(k))) fail();
    const e = v.evidence as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || Array.isArray(e) || !["measured", "estimated", "unconfirmed"].includes(String(e.confidence)) ||
        typeof e.source !== "string" || !e.source.trim() || typeof e.scope !== "string" || !e.scope.trim() ||
        Object.keys(e).some(k => !["confidence", "source", "scope"].includes(k))) fail();
    if ("method" in v && !methods.includes(v.method as Verdict["method"])) fail();
    if ("implementation" in v && !["unknown", "planned", "partial", "output", "loss-only"].includes(String(v.implementation))) fail();
    if ("issue" in v && v.issue !== null && (!Number.isSafeInteger(v.issue) || (v.issue as number) <= 0)) fail();
    if ("loss" in v && v.loss !== null && (!Array.isArray(v.loss) || v.loss.some(x => typeof x !== "string"))) fail();
    const override = v as unknown as Override;
    const key = rowKey(override.family, override.id);
    if (seen.has(key)) throw new Error(`Duplicate verdict ${key}`);
    seen.add(key);
    const row = rows.get(key);
    if (!row) { missing.push(override); continue; }
    const differing: Record<string, { machine: unknown; override: unknown }> = {};
    for (const field of fields) if (field in override) {
      if (JSON.stringify(row[field]) !== JSON.stringify(override[field])) differing[field] = { machine: row[field], override: override[field] };
    }
    if (Object.keys(differing).length) conflicts.push({ key, fields: differing });
    rows.set(key, { ...row, ...Object.fromEntries(fields.filter(field => field in override).map(field => [field, override[field]])) });
  }
  return { missing: missing.sort((a, b) => rowKey(a.family, a.id).localeCompare(rowKey(b.family, b.id))), conflicts: conflicts.sort((a, b) => a.key.localeCompare(b.key)) };
}
