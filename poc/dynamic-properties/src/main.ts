// 動的プロパティの容量上限と復元のPoC。
// `scriptevent je2be:dp <JSON {id, op, ...}>` を受け、`POC_DP <JSON {id, ok, result|error}>` を出す。
// 重い測定は system.runJob で少しずつ進める（ウォッチドッグで止められないように）。
import { system, world, type Entity } from "@minecraft/server";

interface Holder {
  setDynamicProperty(id: string, value?: string): void;
  getDynamicProperty(id: string): unknown;
  getDynamicPropertyTotalByteCount(): number;
  clearDynamicProperties(): void;
}

function reply(id: number, body: Record<string, unknown>): void {
  console.log("POC_DP " + JSON.stringify({ id, ...body }));
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function tryWrite(h: Holder, key: string, value: string): string | undefined {
  try {
    h.setDynamicProperty(key, value);
    return undefined;
  } catch (e) {
    return errText(e);
  }
}

/** 1件の文字列の最大長を二分探索する。上限が cap 以上なら cap を返す */
function* maxString(h: Holder, ch: string, cap: number, out: Record<string, unknown>): Generator<void> {
  let lo = 0;
  let hi = 1;
  let lastError: string | undefined;
  while (hi <= cap) {
    const err = tryWrite(h, "probe", ch.repeat(hi));
    yield;
    if (err) { lastError = err; break; }
    lo = hi;
    hi *= 2;
  }
  if (hi > cap) {
    out.max = lo;
    out.reachedCap = true;
  } else {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const err = tryWrite(h, "probe", ch.repeat(mid));
      yield;
      if (err) { hi = mid; lastError = err; } else lo = mid;
    }
    out.max = lo;
    out.error = lastError;
  }
  h.setDynamicProperty("probe", undefined);
}

/** 決まった大きさの値を書き続け、合計の上限を探す */
function* total(h: Holder, chunk: number, capBytes: number, out: Record<string, unknown>): Generator<void> {
  const value = "a".repeat(chunk);
  let n = 0;
  for (;;) {
    const err = tryWrite(h, `fill_${n}`, value);
    if (err) { out.error = err; break; }
    n++;
    if (n % 16 === 0) yield;
    if (h.getDynamicPropertyTotalByteCount() >= capBytes) { out.reachedCap = true; break; }
  }
  out.keys = n;
  out.totalBytes = h.getDynamicPropertyTotalByteCount();
  h.clearDynamicProperties();
  out.afterClear = h.getDynamicPropertyTotalByteCount();
}

function holder(target: string): Holder {
  if (target === "world") return world;
  const e = world.getDimension("overworld").getEntities({ tags: [target] })[0];
  if (!e) throw new Error(`entity with tag ${target} not found`);
  return e as Entity;
}

function runJob(id: number, gen: (out: Record<string, unknown>) => Generator<void>): void {
  const out: Record<string, unknown> = {};
  const started = Date.now();
  system.runJob(
    (function* () {
      try {
        yield* gen(out);
        reply(id, { ok: true, result: { ...out, ms: Date.now() - started } });
      } catch (e) {
        reply(id, { ok: false, error: errText(e) });
      }
    })(),
  );
}

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "je2be:dp") return;
  const req = JSON.parse(ev.message) as { id: number; op: string; target?: string; ch?: string; cap?: number; chunk?: number; key?: string; value?: string };
  try {
    switch (req.op) {
      case "maxString":
        return runJob(req.id, (out) => maxString(holder(req.target ?? "world"), req.ch ?? "a", req.cap ?? 1 << 22, out));
      case "total":
        return runJob(req.id, (out) => total(holder(req.target ?? "world"), req.chunk ?? 1 << 15, req.cap ?? 1 << 26, out));
      case "set": {
        const h = holder(req.target ?? "world");
        h.setDynamicProperty(req.key!, req.value);
        return reply(req.id, { ok: true, result: { totalBytes: h.getDynamicPropertyTotalByteCount() } });
      }
      case "setRepeat": {
        // 長い値はコンソールで送れないため、パック側で作る
        const h = holder(req.target ?? "world");
        h.setDynamicProperty(req.key!, (req.ch ?? "a").repeat(req.chunk ?? 1));
        return reply(req.id, { ok: true, result: { totalBytes: h.getDynamicPropertyTotalByteCount() } });
      }
      case "fill": {
        // 決まった数のキーを書く（消さない）。再起動後の復元の確認用
        const h = holder(req.target ?? "world");
        const value = "e".repeat(req.chunk ?? 32_000);
        for (let i = 0; i < (req.cap ?? 0); i++) h.setDynamicProperty(`bulk_${i}`, value);
        return reply(req.id, { ok: true, result: { totalBytes: h.getDynamicPropertyTotalByteCount() } });
      }
      case "count": {
        const h = holder(req.target ?? "world") as Holder & { getDynamicPropertyIds(): string[] };
        const ids = h.getDynamicPropertyIds().filter((k) => k.startsWith("bulk_"));
        const intact = ids.filter((k) => (h.getDynamicProperty(k) as string | undefined)?.length === (req.chunk ?? 32_000)).length;
        return reply(req.id, { ok: true, result: { keys: ids.length, intact, totalBytes: h.getDynamicPropertyTotalByteCount() } });
      }
      case "get": {
        const h = holder(req.target ?? "world");
        const v = h.getDynamicProperty(req.key!);
        return reply(req.id, { ok: true, result: { type: typeof v, length: typeof v === "string" ? v.length : null, head: typeof v === "string" ? v.slice(0, 16) : v } });
      }
      default:
        return reply(req.id, { ok: false, error: `unknown op ${req.op}` });
    }
  } catch (e) {
    reply(req.id, { ok: false, error: errText(e) });
  }
});

system.run(() => console.log("POC_DP_READY"));
