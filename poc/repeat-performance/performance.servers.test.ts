// #5: Linux BDSのCPU時間とtick間隔を測る。速度の固定閾値はCIの合否条件にしない。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, loadavg, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BedrockServer } from "@je2be/bridge";
import { buildMcstructure, commandBlock } from "@je2be/core";

const here = dirname(fileURLToPath(import.meta.url));
const pack = join(here, "pack");
const LIMIT = 100;
const WARMUP = 20;
const REPEATS = 2;
type Mode = "baseline" | "native" | "custom" | "scriptevent";
interface Case { mode: Mode; count: number; layout: "dense" | "spread" }
interface Sample { tick: number; gap: number; intervalMs: number; jobs: number; drainMs: number; maxDelayTicks: number }
const cases: Case[] = [
  { mode: "baseline", count: 0, layout: "dense" },
  ...[100, 500].flatMap((count) => (["native", "custom", "scriptevent"] as const).map((mode) => ({ mode, count, layout: "dense" as const }))),
  ...(["native", "custom", "scriptevent"] as const).map((mode) => ({ mode, count: 500, layout: "spread" as const })),
];

// /proc/PID/stat fields 14/15 = user/system CPU clock ticks（全スレッドの合計）。
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
function cpuTicks(pid: number): number {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
  const result = Number(fields[11]) + Number(fields[12]);
  if (!Number.isFinite(result)) throw new Error("invalid /proc CPU counters");
  return result;
}

function stats(values: number[]): { mean: number; p50: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number): number => sorted[Math.ceil(sorted.length * p) - 1]!;
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, p50: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1)! };
}

it("records tick intervals and process CPU for native and queued repeat blocks", async () => {
  expect(platform()).toBe("linux"); // BDSのLinux配布と /proc を使うPoC
  const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  expect(hz).toBeGreaterThan(0);
  mkdirSync(join(pack, "structures", "je2be"), { recursive: true });
  for (const c of cases.filter((c) => c.count > 0)) {
    const stride = c.layout === "spread" ? 2 : 1;
    const width = c.count === 100 ? 16 : 32;
    const bytes = buildMcstructure({ size: [32 * stride, 1, 16 * stride], blocks: Array.from({ length: c.count }, (_, id) =>
      commandBlock({ pos: [(id % width) * stride, 0, Math.floor(id / width) * stride], kind: "repeat", facing: 1, alwaysActive: true,
        command: c.mode === "native" ? `scoreboard players add b${id} perf 1` : c.mode === "custom" ? `je2be:perf ${id}` : `scriptevent je2be:perf ${id}`,
      })),
    });
    writeFileSync(join(pack, "structures", "je2be", `perf_${c.mode}_${c.count}_${c.layout}.mcstructure`), bytes);
  }

  const config = JSON.parse(readFileSync(join(here, "../../tools/servers.json"), "utf8")) as { bedrock: { version: string } };
  const results = {
    environment: { bedrock: config.bedrock.version, node: process.version, os: `${platform()} ${release()}`, arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), clockTicksPerSecond: hz },
    method: { samplesPerRun: LIMIT, warmupTicks: WARMUP, repetitions: REPEATS, cpuIncludesAllBdsThreads: true, cpuIsNotMainThreadMspt: true, scriptTimerResolutionMs: 1 },
    runs: [] as Record<string, unknown>[],
  };
  const raw: string[] = [];
  const bds = await BedrockServer.start({ behaviorPacks: [pack] });
  const ping = async (): Promise<number> => {
    const res = await bds.request<{ tick: number }>("ping");
    expect(res.ok).toBe(true);
    return res.result!.tick;
  };
  try {
    expect((await bds.exec("gamerule commandblockoutput false")).result?.successCount).toBe(1);
    for (let repetition = 0; repetition < REPEATS; repetition++) {
      const order = repetition % 2 ? [...cases].reverse() : cases;
      for (const c of order) {
        const id = `${repetition}_${c.mode}_${c.count}_${c.layout}`;
        expect((await bds.exec("fill 0 -50 0 63 -50 31 air")).ok).toBe(true);
        expect((await bds.exec("scriptevent je2be:perf-reset reset")).result?.successCount).toBe(1);
        await bds.exec("scoreboard objectives remove perf");
        expect((await bds.exec("scoreboard objectives add perf dummy")).result?.successCount).toBe(1);
        if (c.count) expect((await bds.exec(`structure load je2be:perf_${c.mode}_${c.count}_${c.layout} 0 -50 0`)).result?.successCount).toBe(1);
        const loaded = await ping();
        while ((await ping()) - loaded < WARMUP) await new Promise((r) => setTimeout(r, 100));

        const startTick = await ping();
        const startCpu = cpuTicks(bds.pid);
        const startWall = process.hrtime.bigint();
        const startLoad = loadavg();
        const startLog = bds.log.length;
        expect((await bds.exec(`scriptevent je2be:perf-start ${JSON.stringify({ id, limit: LIMIT, count: c.count })}`)).result?.successCount).toBe(1);
        const deadline = Date.now() + 30_000;
        while (!bds.log.slice(startLog).some((l) => l.includes(`PERF_DONE {"id":"${id}"`))) {
          if (Date.now() > deadline) throw new Error(`performance sample timeout: ${id}`);
          await new Promise((r) => setTimeout(r, 50));
        }
        const endTick = await ping();
        const endCpu = cpuTicks(bds.pid);
        const wallMs = Number(process.hrtime.bigint() - startWall) / 1e6;
        const samples = bds.log.slice(startLog).flatMap((line): Sample[] => {
          const pos = line.indexOf("PERF_SAMPLES ");
          if (pos < 0) return [];
          const chunk = JSON.parse(line.slice(pos + "PERF_SAMPLES ".length)) as { id: string; samples: Sample[] };
          return chunk.id === id ? chunk.samples : [];
        });
        const doneLine = bds.log.slice(startLog).find((l) => l.includes(`PERF_DONE {"id":"${id}"`))!;
        const { deltas } = JSON.parse(doneLine.slice(doneLine.indexOf("PERF_DONE ") + "PERF_DONE ".length)) as { deltas: number[] };
        expect(deltas).toHaveLength(c.count);
        expect(deltas.every((n) => n >= 0 && n <= LIMIT)).toBe(true);
        expect(samples).toHaveLength(LIMIT);
        expect(new Set(samples.map((s) => s.gap))).toEqual(new Set([1]));
        expect(samples.at(-1)!.tick - samples[0]!.tick).toBe(LIMIT - 1);
        const jobs = c.mode === "custom" || c.mode === "scriptevent" ? c.count : 0;
        if (c.count <= 100) expect(new Set(samples.map((s) => s.jobs))).toEqual(new Set([jobs]));
        else expect(samples.every((s) => s.jobs >= 0 && s.jobs <= jobs)).toBe(true);
        expect(new Set(samples.map((s) => s.maxDelayTicks))).toEqual(new Set([c.mode === "scriptevent" ? 1 : 0]));
        if (c.count === 100) expect(new Set(deltas)).toEqual(new Set([LIMIT]));
        const writes = deltas.reduce((a, b) => a + b, 0);
        if (jobs) expect(samples.reduce((n, s) => n + s.jobs, 0)).toBe(writes);

        const scoreResponse = await bds.request<{ objective: string; scores: { participant: string; score: number }[] }[]>("scores");
        expect(scoreResponse.ok).toBe(true);
        const scores = scoreResponse.result!.find((o) => o.objective === "perf")!.scores;
        expect(scores).toHaveLength(c.count);
        expect(new Set(scores.map((s) => s.participant))).toEqual(new Set(Array.from({ length: c.count }, (_, i) => `b${i}`)));
        if (c.count) {
          expect(Math.min(...scores.map((s) => s.score))).toBeGreaterThan(0);
        }
        const windowTicks = endTick - startTick;
        const cpuMs = (endCpu - startCpu) * 1000 / hz;
        results.runs.push({ id, ...c, repetition, startTick, endTick, windowTicks, wallMs, processCpuMs: cpuMs, processCpuMsPerTick: cpuMs / windowTicks, processCpuClockTicks: endCpu - startCpu,
          intervalMs: stats(samples.map((s) => s.intervalMs)), intervalsOver75Ms: samples.filter((s) => s.intervalMs > 75).length,
          drainMs: stats(samples.map((s) => s.drainMs)), expectedWritesPerTick: c.count, observedWritesPerTick: writes / LIMIT,
          perBlockWrites: c.count ? { min: Math.min(...deltas), max: Math.max(...deltas) } : null,
          queuedJobsPerTick: stats(samples.map((s) => s.jobs)), maxDelayTicks: Math.max(...samples.map((s) => s.maxDelayTicks)), startLoad,
        });
        raw.push(JSON.stringify({ id, ticks: samples.map((s) => s.tick), intervalMs: samples.map((s) => s.intervalMs), drainMs: samples.map((s) => s.drainMs), jobs: samples.map((s) => s.jobs), deltas }));
      }
    }
    expect(bds.log.filter((line) => /\[Scripting\].*(?:ERROR|Error|watchdog)/i.test(line))).toEqual([]);
    writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");
    writeFileSync(join(here, "samples.jsonl"), raw.join("\n") + "\n");
  } finally { await bds.stop(); }
});
