// 最小のランタイム呼び出し: 起動口でIDをキューに積み、runIntervalで同じスコア加算コマンドを実行する。
// 完成したランタイムの性能ではない。測定中はtickごとにログを出さない。
import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, system, world } from "@minecraft/server";

interface Job { id: number; tick: number }
interface Sample { tick: number; gap: number; intervalMs: number; jobs: number; drainMs: number; maxDelayTicks: number }
let queue: Job[] = [];
let measurement: { id: string; limit: number; count: number; before: number[]; samples: Sample[] } | undefined;
let previousTime = Date.now();
let previousTick = system.currentTick;

function scores(count: number): number[] {
  const objective = world.scoreboard.getObjective("perf")!;
  const values = new Map(objective.getScores().map((s) => [s.participant.displayName, s.score]));
  return Array.from({ length: count }, (_, id) => values.get(`b${id}`) ?? 0);
}

function enqueue(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id >= 500) throw new Error(`invalid job ${id}`);
  queue.push({ id, tick: system.currentTick });
}

system.beforeEvents.startup.subscribe((ev) => {
  ev.customCommandRegistry.registerCommand({
    name: "je2be:perf",
    description: "Queue a performance probe write",
    permissionLevel: CommandPermissionLevel.GameDirectors,
    mandatoryParameters: [{ name: "id", type: CustomCommandParamType.Integer }],
  }, (_origin, id: number) => {
    enqueue(id);
    return { status: CustomCommandStatus.Success };
  });
});

system.runInterval(() => {
  const now = Date.now();
  const tick = system.currentTick;
  const pending = queue;
  queue = [];
  let maxDelayTicks = 0;
  const dim = world.getDimension("overworld");
  const begin = Date.now();
  for (const job of pending) {
    maxDelayTicks = Math.max(maxDelayTicks, tick - job.tick);
    const result = dim.runCommand(`scoreboard players add b${job.id} perf 1`);
    if (result.successCount !== 1) throw new Error(`score write failed for ${job.id}`);
  }
  const drainMs = Date.now() - begin;
  if (measurement) {
    measurement.samples.push({ tick, gap: tick - previousTick, intervalMs: now - previousTime, jobs: pending.length, drainMs, maxDelayTicks });
    if (measurement.samples.length === measurement.limit) {
      const deltas = scores(measurement.count).map((n, i) => n - measurement!.before[i]!);
      // BDSの長い1行を避け、測定が終わってから10tick分ずつ出す。
      for (let i = 0; i < measurement.samples.length; i += 10) {
        console.log("PERF_SAMPLES " + JSON.stringify({ id: measurement.id, samples: measurement.samples.slice(i, i + 10) }));
      }
      console.log("PERF_DONE " + JSON.stringify({ id: measurement.id, deltas }));
      measurement = undefined;
    }
  }
  previousTime = now;
  previousTick = tick;
}, 1);

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id === "je2be:perf") enqueue(Number(ev.message));
  else if (ev.id === "je2be:perf-reset") { queue = []; measurement = undefined; }
  else if (ev.id === "je2be:perf-start") {
    const args = JSON.parse(ev.message) as { id: string; limit: number; count: number };
    measurement = { ...args, before: scores(args.count), samples: [] };
  }
});

system.run(() => console.log("PERF_READY"));
