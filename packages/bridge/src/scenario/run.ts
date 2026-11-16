// シナリオを Java 版サーバーと BDS で実行し、観測結果をそろえた形で返す（#38）。
// どちらもシナリオごとに新しいワールドで起動する（状態が混ざらないように）。
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcstructure, commandBlock, type Facing as BeFacing } from "@je2be/core";
import { convertWorld, INIT_LOG_MARK, type ConvertReport } from "@je2be/converter";
import { BedrockServer } from "../bedrock.ts";
import { JavaServer } from "../java.ts";
import { paths, repoRoot } from "../paths.ts";
import { createDataPack, waitBedrockTicks } from "../poc-kit.ts";
import { normalizeBedrock, normalizeJava, type BedrockBlockMapper, type RawBlock, type RawEntity, type RawScores } from "./normalize.ts";
import type { Action, NormalizedState, Scenario, ScenarioCommandBlock, Vec3 } from "./types.ts";

const FACING_TO_BE: Record<ScenarioCommandBlock["facing"], BeFacing> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };

/** Java のコマンドの応答のうち、失敗を表すもの */
const JAVA_ERROR = /Unknown or incomplete command|Incorrect argument|<--\[HERE\]|Unknown (function|objective|scoreboard objective)|Expected /;

export class ScenarioError extends Error {}

function blockRange(b: { from: Vec3; to?: Vec3 }): [Vec3, Vec3] {
  return [b.from, b.to ?? b.from];
}

// ---- Java ----

async function javaTicks(java: JavaServer, n: number): Promise<void> {
  const gametime = async (): Promise<number> => Number(/(\d+)/.exec(await java.exec("time query gametime"))?.[1]);
  const start = await gametime();
  await java.exec(`tick step ${n}`);
  const deadline = Date.now() + 30_000 + n * 100;
  while ((await gametime()) < start + n) {
    if (Date.now() > deadline) throw new ScenarioError(`java: tick step ${n} did not finish`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function javaAction(java: JavaServer, a: Action, log: string[]): Promise<void> {
  if ("run" in a) {
    const res = await java.exec(a.run);
    log.push(`> ${a.run}\n${res}`);
    if (JAVA_ERROR.test(res)) throw new ScenarioError(`java: ${a.run}: ${res}`);
  } else if ("ticks" in a) {
    await javaTicks(java, a.ticks);
  } else {
    for (const cb of a.commandBlocks) {
      const id = cb.kind === "impulse" ? "command_block" : cb.kind === "chain" ? "chain_command_block" : "repeating_command_block";
      const nbt = `{Command:${JSON.stringify(cb.command)},auto:${cb.alwaysActive === false ? 0 : 1}b}`;
      const res = await java.exec(`setblock ${cb.pos.join(" ")} minecraft:${id}[facing=${cb.facing},conditional=${cb.conditional ? "true" : "false"}]${nbt}`);
      log.push(`> setblock ${cb.pos.join(" ")} ${id}\n${res}`);
      if (!/Changed the block/.test(res)) throw new ScenarioError(`java: command block at ${cb.pos}: ${res}`);
    }
  }
}

export async function runJava(s: Scenario): Promise<{ state: NormalizedState; log: string[] }> {
  const log: string[] = [];
  const java = await JavaServer.start();
  try {
    // tick を止め、シナリオの ticks だけ進める（決定的にするため）
    await java.exec("tick freeze");
    for (const c of s.setup) await javaAction(java, { run: c }, log);
    for (const a of s.actions) await javaAction(java, a, log);
    for (const a of s.play ?? []) await javaAction(java, a, log);
    const dump = await java.dump({
      scores: !!s.observe.scores,
      entities: !!s.observe.entityTags,
    });
    const blocks = [];
    for (const b of s.observe.blocks ?? []) {
      const [from, to] = blockRange(b);
      blocks.push(...((await java.dump({ blocks: { from, to } })).blocks ?? []));
    }
    return { state: normalizeJava(s.observe, { ...(dump.scores ? { scores: dump.scores } : {}), blocks, ...(dump.entities ? { entities: dump.entities } : {}) }), log };
  } finally {
    await java.stop();
  }
}

// ---- 変換 ----

const chunkerJar = (): string => {
  const servers = JSON.parse(readFileSync(join(repoRoot, "tools/servers.json"), "utf8")) as { chunker: { version: string } };
  return join(paths.servers, "tools", `chunker-cli-${servers.chunker.version}.jar`);
};

/**
 * Java で setup と actions まで行ったワールドを保存し、変換器に通す。変換後の BE ワールドのディレクトリを返す。
 * 呼び出し側で work を消すこと
 */
export async function buildConvertedWorld(s: Scenario, log: string[]): Promise<{ work: string; world: string; report: ConvertReport }> {
  const java = await JavaServer.start();
  const work = mkdtempSync(join(tmpdir(), "je2be-scenario-convert-"));
  try {
    try {
      await java.exec("tick freeze");
      for (const c of s.setup) await javaAction(java, { run: c }, log);
      for (const a of s.actions) await javaAction(java, a, log);
      await java.dump({});
    } finally {
      await java.stop();
    }
    cpSync(join(paths.javaServer, "je2be-test"), join(work, "java"), { recursive: true });
    const world = join(work, "bedrock");
    const report = convertWorld(join(work, "java"), world, { java: paths.java, chunkerJar: chunkerJar() });
    log.push(`convert: ${JSON.stringify(report)}`);
    return { work, world, report };
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

// ---- Bedrock ----

/** コマンドブロックを置く操作ごとに .mcstructure を作り、データだけのビヘイビアーパックにまとめる */
function buildStructurePack(actions: Action[]): { dir: string; loads: Map<Action, { id: string; origin: Vec3 }> } {
  const structures: Record<string, Uint8Array> = {};
  const loads = new Map<Action, { id: string; origin: Vec3 }>();
  actions.forEach((a, i) => {
    if (!("commandBlocks" in a)) return;
    const min = [0, 1, 2].map((k) => Math.min(...a.commandBlocks.map((c) => c.pos[k]!))) as Vec3;
    const max = [0, 1, 2].map((k) => Math.max(...a.commandBlocks.map((c) => c.pos[k]!))) as Vec3;
    const blocks = a.commandBlocks.map((c) =>
      commandBlock({
        pos: [c.pos[0] - min[0], c.pos[1] - min[1], c.pos[2] - min[2]],
        kind: c.kind,
        command: c.command,
        facing: FACING_TO_BE[c.facing],
        conditional: c.conditional ?? false,
        alwaysActive: c.alwaysActive ?? true,
      }),
    );
    const size = [0, 1, 2].map((k) => max[k]! - min[k]! + 1) as Vec3;
    // fillAir: false で、周りの既存ブロックを消さない
    structures[`cb_${i}`] = buildMcstructure({ size, blocks, fillAir: false });
    loads.set(a, { id: `je2be:cb_${i}`, origin: min });
  });
  return { dir: createDataPack(structures), loads };
}

export async function runBedrock(s: Scenario, mapBlock?: BedrockBlockMapper): Promise<{ state: NormalizedState; log: string[] }> {
  const log: string[] = [];
  if (s.play && s.bedrock) throw new ScenarioError(`${s.id}: play（変換を通す）と bedrock は併用できない`);
  const converted = s.play ? await buildConvertedWorld(s, log) : undefined;
  // 変換を通すときは、setup と actions は変換前の Java ワールドで済んでいる
  const setup = converted ? [] : (s.bedrock?.setup ?? s.setup);
  const actions = converted ? (s.play ?? []) : (s.bedrock?.actions ?? s.actions);
  const pack = buildStructurePack(actions);
  let bds: BedrockServer;
  try {
    bds = await BedrockServer.start({ behaviorPacks: [pack.dir], ...(converted ? { world: converted.world } : {}) });
  } catch (e) {
    rmSync(pack.dir, { recursive: true, force: true });
    if (converted) rmSync(converted.work, { recursive: true, force: true });
    throw e;
  }
  try {
    if (converted) {
      // 初期化パックがスコアを書き込み終えるのを待つ（初回読み込み時に1度だけ動く）
      const line = await bds.waitForLog((l) => l.includes(INIT_LOG_MARK), 30_000, "init pack");
      log.push(line);
    }
    const run = async (c: string): Promise<void> => {
      const res = await bds.exec(c);
      log.push(`> ${c}\n${JSON.stringify(res.ok ? res.result : res.error)}`);
      if (!res.ok) throw new ScenarioError(`bedrock: ${c}: ${res.error}`);
    };
    for (const c of setup) await run(c);
    for (const a of actions) {
      if ("run" in a) await run(a.run);
      else if ("ticks" in a) await waitBedrockTicks(bds, a.ticks);
      else {
        const load = pack.loads.get(a)!;
        const res = await bds.exec(`structure load ${load.id} ${load.origin.join(" ")}`);
        log.push(`> structure load ${load.id}\n${JSON.stringify(res)}`);
        if (res.result?.successCount !== 1) throw new ScenarioError(`bedrock: structure load ${load.id}: ${JSON.stringify(res)}`);
      }
    }
    const scores = s.observe.scores ? ((await bds.request<RawScores[]>("scores")).result ?? []) : undefined;
    const blocks: RawBlock[] = [];
    for (const b of s.observe.blocks ?? []) {
      const [from, to] = blockRange(b);
      blocks.push(...((await bds.request<RawBlock[]>("blocks", { from, to })).result ?? []));
    }
    const entities = s.observe.entityTags ? ((await bds.request<RawEntity[]>("entities", {})).result ?? []) : undefined;
    return { state: normalizeBedrock(s.observe, { ...(scores ? { scores } : {}), blocks, ...(entities ? { entities } : {}) }, mapBlock), log };
  } finally {
    await bds.stop();
    rmSync(pack.dir, { recursive: true, force: true });
    if (converted) rmSync(converted.work, { recursive: true, force: true });
  }
}
