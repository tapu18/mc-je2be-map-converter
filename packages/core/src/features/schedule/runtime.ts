export interface ScheduledTarget { id: string; tag: boolean }
interface ScheduledEntry extends ScheduledTarget { dueTick: number }

const targetKey = ({id, tag}: ScheduledTarget): string => tag ? `#${id}` : id;

/** Logical game time and pending callbacks. Each tick's map preserves registration order. */
export class ScheduleState {
  private currentTick = 0;
  private readonly pending = new Map<number, Map<string, ScheduledTarget>>();

  get tick(): number { return this.currentTick; }

  schedule(target: ScheduledTarget, dueTick: number, replace: boolean): void {
    const key = targetKey(target);
    if (replace) this.clear(target);
    let entries = this.pending.get(dueTick);
    if (!entries) this.pending.set(dueTick, entries = new Map());
    if (!entries.has(key)) entries.set(key, target);
  }

  clear(target: ScheduledTarget): number {
    const key = targetKey(target);
    let count = 0;
    for (const [tick, entries] of this.pending) {
      if (entries.delete(key)) count++;
      if (entries.size === 0) this.pending.delete(tick);
    }
    return count;
  }

  *advanceTick(): IterableIterator<ScheduledTarget> {
    const tick = this.currentTick + 1;
    if (!Number.isSafeInteger(tick)) throw Error("schedule tick exhausted");
    this.currentTick = tick;
    const entries = this.pending.get(tick);
    if (!entries) return;
    for (const [key, target] of entries) {
      // Retire one callback at a time so it can clear later callbacks on this same tick.
      entries.delete(key);
      yield target;
    }
    this.pending.delete(tick);
  }

  snapshot(): { tick: number; entries: ScheduledEntry[] } {
    const entries: ScheduledEntry[] = [];
    for (const [dueTick, targets] of this.pending) {
      for (const target of targets.values()) entries.push({...target, dueTick});
    }
    return {tick: this.currentTick, entries};
  }

  restore(snapshot: unknown): void {
    if (typeof snapshot !== "object" || snapshot === null) throw Error("invalid schedule state");
    const {tick, entries} = snapshot as ReturnType<ScheduleState["snapshot"]>;
    if (!Number.isSafeInteger(tick) || tick < 0 || !Array.isArray(entries)) throw Error("invalid schedule state");
    const restored = new ScheduleState();
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string" || !/^[a-z0-9_.-]*:[a-z0-9_./-]*$/.test(entry.id) || typeof entry.tag !== "boolean"
        || !Number.isSafeInteger(entry.dueTick) || entry.dueTick <= tick
        || restored.pending.get(entry.dueTick)?.has(targetKey(entry))) throw Error("invalid schedule entry");
      restored.schedule({id: entry.id, tag: entry.tag}, entry.dueTick, false);
    }
    this.pending.clear();
    for (const [dueTick, targets] of restored.pending) this.pending.set(dueTick, targets);
    this.currentTick = tick;
  }
}
