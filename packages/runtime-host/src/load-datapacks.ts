import { deserializeCommandIR } from "../../core/src/command/ir-codec.ts";
import type { RuntimeState } from "../../core/src/runtime/command.ts";

type Pack = { functions: Record<string, string[]>; tags: Record<string, unknown> };
export type Datapacks = { schemaVersion: 1; packs: Pack[] };

/** Load ordered pack overrides and resolve function tags before any function runs. */
export function loadDatapacks(state: RuntimeState, data: Datapacks): void {
  if (data.schemaVersion !== 1) throw Error("unsupported datapack schema");
  const tags = new Map<string, { id: string; required: boolean }[]>();
  for (const pack of data.packs) {
    for (const [id, lines] of Object.entries(pack.functions)) {
      state.functions.set(id, lines.map(line => {
        const decoded = deserializeCommandIR(line);
        if (!decoded.ok) throw Error(`function ${id}: ${decoded.diagnostic}`);
        return decoded.document.ir;
      }));
    }
    for (const [id, raw] of Object.entries(pack.tags)) {
      if (!raw || typeof raw !== "object" || !("values" in raw) || !Array.isArray(raw.values)) throw Error(`invalid tag ${id}`);
      const tag = raw as { replace?: unknown; values: unknown[] };
      if (tag.replace !== undefined && typeof tag.replace !== "boolean") throw Error(`invalid tag ${id}`);
      const values = tag.replace ? [] : [...(tags.get(id) ?? [])];
      for (const value of tag.values) {
        if (typeof value === "string") values.push({ id: value, required: true });
        else if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && (!('required' in value) || typeof value.required === "boolean")) values.push({ id: value.id, required: !('required' in value) || value.required as boolean });
        else throw Error(`invalid tag entry ${id}`);
      }
      tags.set(id, values);
    }
  }
  const resolve = (id: string, stack: string[]): string[] => {
    if (stack.includes(id)) throw Error(`cyclic function tag ${id}`);
    const entries = tags.get(id);
    if (!entries) throw Error(`missing function tag ${id}`);
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.id.startsWith("#")) {
        const nested = entry.id.slice(1);
        if (tags.has(nested)) result.push(...resolve(nested, [...stack, id]));
        else if (entry.required) throw Error(`missing function tag ${nested}`);
      } else if (state.functions.has(entry.id)) result.push(entry.id);
      else if (entry.required) throw Error(`missing function ${entry.id}`);
    }
    return [...new Set(result)];
  };
  for (const id of tags.keys()) state.functionTags.set(id, resolve(id, []));
}
