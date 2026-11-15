// PoC と正解データのシナリオで共通に使う小道具（#39）。書き方は docs/poc.md。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BedrockServer } from "./bedrock.ts";

// ---- パックの出力ログ ----

/**
 * サーバーのログから、`<prefix> <JSON>` の形の行を取り出して JSON として返す。
 * 例：パック側で `console.log("POC " + JSON.stringify({...}))` と出したものを `jsonLines(bds.log, "POC")` で読む。
 * `from` を渡すと、その行番号より後だけを見る（同じサーバーで何度も記録するとき）。
 */
export function jsonLines<T = Record<string, unknown>>(log: readonly string[], prefix: string, from = 0): T[] {
  const marker = `${prefix} {`;
  const out: T[] = [];
  for (let i = from; i < log.length; i++) {
    const line = log[i]!;
    const at = line.indexOf(marker);
    if (at >= 0) out.push(JSON.parse(line.slice(at + prefix.length + 1)) as T);
  }
  return out;
}

/** 条件に合う行がログに出るまで待つ（`from` より後の行だけを見る） */
export async function waitForLog(log: readonly string[], pred: (line: string) => boolean, timeoutMs = 30_000, from = 0): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = from; i < log.length; i++) if (pred(log[i]!)) return log[i]!;
    if (Date.now() > deadline) throw new Error("timeout waiting for log line");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- tick ごとの集計 ----

export interface TickMark {
  tick: number;
  source: string;
}

export interface TickOrders {
  /** 集計に使った tick 数（最初と最後の tick は、途中から・途中までになるため除く） */
  ticks: number;
  /** 出てきた並びと回数（多い順） */
  orders: { order: string[]; count: number }[];
}

/**
 * 記録の並び（通し番号順）を tick ごとにまとめ、出てきた並びの種類と回数を返す。
 * 記録の最初と最後の tick は途中から・途中までになるため除く。
 */
export function tickOrders(marks: readonly TickMark[], filter: (source: string) => boolean = () => true): TickOrders {
  const byTick = new Map<number, string[]>();
  for (const m of marks) {
    if (!filter(m.source)) continue;
    byTick.set(m.tick, [...(byTick.get(m.tick) ?? []), m.source]);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b).slice(1, -1);
  const counts = new Map<string, number>();
  for (const t of ticks) {
    const k = byTick.get(t)!.join("\u0000");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const orders = [...counts].sort((a, b) => b[1] - a[1]).map(([k, count]) => ({ order: k.split("\u0000"), count }));
  return { ticks: ticks.length, orders };
}

/** 並びの中での a と b の前後が、全 tick で同じか */
export function relativeOrder(summary: TickOrders, a: string, b: string): "before" | "after" | "varies" {
  const rel = new Set(summary.orders.map((o) => (o.order.indexOf(a) < o.order.indexOf(b) ? "before" : "after")));
  return rel.size === 1 ? [...rel][0]! : "varies";
}

// ---- パック ----

/** パックの structures/je2be/<name>.mcstructure に書く。BE では `structure load je2be:<name>` で読み込める */
export function writeStructure(packDir: string, name: string, bytes: Uint8Array): string {
  const dir = join(packDir, "structures", "je2be");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.mcstructure`), bytes);
  return `je2be:${name}`;
}

/** 構造物だけを持つ、スクリプトなしのビヘイビアーパックを一時ディレクトリに作る */
export function createDataPack(structures: Record<string, Uint8Array> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "je2be-data-pack-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      format_version: 2,
      header: { name: "je2be data pack", description: "", uuid: randomUUID(), version: [0, 1, 0], min_engine_version: [1, 26, 60] },
      modules: [{ type: "data", uuid: randomUUID(), version: [0, 1, 0] }],
    }),
  );
  for (const [name, bytes] of Object.entries(structures)) writeStructure(dir, name, bytes);
  return dir;
}

// ---- BE の tick ----

/** BE で n tick 経つまで待つ（検証パックの tick 番号を見る） */
export async function waitBedrockTicks(bds: BedrockServer, n: number): Promise<void> {
  const tick = async (): Promise<number> => (await bds.request<{ tick: number }>("ping")).result!.tick;
  const start = await tick();
  const deadline = Date.now() + 30_000 + n * 100;
  while ((await tick()) < start + n) {
    if (Date.now() > deadline) throw new Error(`bedrock: ${n} ticks did not pass`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
