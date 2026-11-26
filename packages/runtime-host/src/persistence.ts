import { deserializeStorage, serializeStorage } from "../../core/src/command/ir-codec.ts";
import { RuntimeState } from "../../core/src/runtime/command.ts";
import type { ExecutionHost } from "../../core/src/runtime/context.ts";

/** Minimal synchronous dynamic-property interface, also usable by a Node fake. */
export interface Properties {
  get(key: string): unknown;
  set(key: string, value?: string): void;
}
type Entry = { kind: "score" | "storage" | "schedule"; id: string; generation: number; chunks: number; slot: number };
type Index = { version: 1; generation: number; entries: Entry[] };
const marker = "je2be:state:commit";
const scheduleId = "queue";
const key = (generation: number, slot: number, chunk: number) => `je2be:state:${generation}:${slot}:${chunk}`;

/** Splits without separating surrogate pairs and without relying on Node or DOM APIs. */
export function splitUtf8(text: string): string[] {
  const chunks: string[] = []; let part = "", size = 0;
  for (const c of text) {
    const n = c.codePointAt(0)!;
    const bytes = n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4;
    if (size + bytes > 32767) { chunks.push(part); part = ""; size = 0; }
    part += c; size += bytes;
  }
  chunks.push(part); return chunks;
}
function readIndex(properties: Properties): Index | undefined {
  const raw = properties.get(marker);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw Error("invalid state commit marker");
  const index = JSON.parse(raw) as Index;
  if (index.version !== 1 || !Number.isSafeInteger(index.generation) || index.generation < 1 || !Array.isArray(index.entries)) throw Error("invalid state index");
  const seen = new Set<string>();
  for (const e of index.entries) {
    if ((e.kind !== "score" && e.kind !== "storage" && !(e.kind === "schedule" && e.id === scheduleId)) || typeof e.id !== "string" || !Number.isSafeInteger(e.generation) || e.generation < 1 || e.generation > index.generation || !Number.isSafeInteger(e.slot) || e.slot < 0 || !Number.isSafeInteger(e.chunks) || e.chunks < 1 || seen.has(`${e.kind}:${e.id}`)) throw Error("invalid state index entry");
    seen.add(`${e.kind}:${e.id}`);
  }
  return index;
}
function payload(properties: Properties, e: Entry): string {
  let result = "";
  for (let i = 0; i < e.chunks; i++) {
    const chunk = properties.get(key(e.generation, e.slot, i));
    if (typeof chunk !== "string") throw Error(`missing state chunk ${e.generation}/${e.slot}/${i}`);
    result += chunk;
  }
  return result;
}
function units(state: RuntimeState): Map<string, {kind: Entry["kind"]; id: string; data: string}> {
  const result = new Map<string, {kind: Entry["kind"]; id: string; data: string}>();
  for (const [id, scores] of state.scores.objectives) result.set(`score:${id}`, {kind: "score", id, data: JSON.stringify([...scores].sort(([a], [b]) => a.localeCompare(b)))});
  for (const [id, value] of state.storage.values) result.set(`storage:${id}`, {kind: "storage", id, data: serializeStorage(value)});
  const schedule = state.schedule.snapshot();
  if (schedule.tick || schedule.entries.length) result.set(`schedule:${scheduleId}`, {kind: "schedule", id: scheduleId, data: JSON.stringify(schedule)});
  return result;
}
/** Restore only the committed index. Missing or malformed committed data is an error. */
export function restoreState(properties: Properties, host?: ExecutionHost): RuntimeState | undefined {
  const index = readIndex(properties); if (!index) return undefined;
  const state = new RuntimeState(host);
  for (const e of index.entries) {
    const data = payload(properties, e);
    if (e.kind === "storage") state.storage.values.set(e.id, deserializeStorage(data));
    else if (e.kind === "schedule") state.schedule.restore(JSON.parse(data));
    else {
      const scores: unknown = JSON.parse(data);
      if (!Array.isArray(scores)) throw Error(`invalid scores ${e.id}`);
      state.scores.addObjective(e.id);
      const seen = new Set<string>();
      for (const pair of scores) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || seen.has(pair[0]) || !state.scores.set(pair[0], e.id, pair[1])) throw Error(`invalid scores ${e.id}`);
        seen.add(pair[0]);
      }
    }
  }
  return state;
}
/** Commit changed units together; a failed write leaves the previous marker untouched. */
export function commitState(properties: Properties, state: RuntimeState): void {
  try {
    const previous = readIndex(properties);
    const generation = (previous?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw Error("generation exhausted");
    const old = new Map((previous?.entries ?? []).map(e => [`${e.kind}:${e.id}`, e]));
    const entries: Entry[] = []; let slot = 0;
    for (const [name, unit] of [...units(state)].sort(([a], [b]) => a.localeCompare(b))) {
      const prior = old.get(name);
      if (prior && payload(properties, prior) === unit.data) { entries.push(prior); continue; }
      const chunks = splitUtf8(unit.data);
      const entry: Entry = {kind: unit.kind, id: unit.id, generation, slot: slot++, chunks: chunks.length};
      chunks.forEach((chunk, i) => properties.set(key(generation, entry.slot, i), chunk));
      entries.push(entry);
    }
    if (previous && entries.length === previous.entries.length && entries.every((entry, i) => entry === previous.entries[i])) return;
    const index: Index = {version: 1, generation, entries};
    const encoded = JSON.stringify(index);
    if (splitUtf8(encoded).length !== 1) throw Error("state index exceeds dynamic property capacity");
    properties.set(marker, encoded);
    const retained = new Set(entries.map(e => `${e.generation}:${e.slot}`));
    for (const e of previous?.entries ?? []) if (!retained.has(`${e.generation}:${e.slot}`)) {
      for (let i = 0; i < e.chunks; i++) properties.set(key(e.generation, e.slot, i), undefined);
    }
  } catch (error) { throw Error(`state persistence failed: ${String(error)}`); }
}
export function restoreOrInitialize(properties: Properties, initial: () => RuntimeState): RuntimeState {
  const restored = restoreState(properties);
  if (restored) return restored;
  const state = initial(); commitState(properties, state); return state;
}
