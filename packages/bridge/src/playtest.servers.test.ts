// 人がボタンで操作する検証用マップ（#86）を作り、Java で押した結果と、CLI で変換した BE ワールドで押した結果を比べる。
// JE2BE_ACCEPTANCE_ARTIFACTS=<ディレクトリ> を付けると、統合版で確かめるための .mcworld とレポートを残す（docs/output-validation.md）。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readNbt, writeNbt, type MappingTables, type NbtTag } from "@je2be/core";
import { INIT_LOG_MARK } from "@je2be/converter";
import { BedrockServer } from "./bedrock.ts";
import { JavaServer } from "./java.ts";
import { paths, repoRoot } from "./paths.ts";
import { bedrockButton, geyserBlockMapper, javaButton, toPlaytest, type Playtest } from "./playtest.ts";
import { waitBedrockTicks } from "./poc-kit.ts";
import { assessComparison, formatDiffs, unexpectedDiffs } from "./scenario/compare.ts";
import { loadScenarios, readGolden } from "./scenario/load.ts";
import { minimalBlockMapper, normalizeBedrock, normalizeJava, type BedrockBlockMapper, type RawBlock, type RawEntity, type RawScores } from "./scenario/normalize.ts";
import { blockRange, javaAction, javaTicks } from "./scenario/run.ts";
import type { NormalizedState, Observe } from "./scenario/types.ts";

/** 人が入ったときに検証用の配置が見える位置 */
const SPAWN = "setworldspawn 0 -60 -3";
const cli = join(repoRoot, "packages/converter/src/cli.ts");

async function observeJava(java: JavaServer, observe: Observe): Promise<NormalizedState> {
  const dump = await java.dump({ scores: !!observe.scores, entities: !!observe.entityTags });
  const blocks = [];
  for (const b of observe.blocks ?? []) {
    const [from, to] = blockRange(b);
    blocks.push(...((await java.dump({ blocks: { from, to } })).blocks ?? []));
  }
  return normalizeJava(observe, { ...(dump.scores ? { scores: dump.scores } : {}), blocks, ...(dump.entities ? { entities: dump.entities } : {}) });
}

async function observeBedrock(bds: BedrockServer, observe: Observe, mapBlock: BedrockBlockMapper): Promise<NormalizedState> {
  const get = async <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await bds.request<T>(op, args);
    if (!r.ok || r.result === undefined) throw new Error(`bedrock observation failed: ${op}: ${r.error ?? "no result"}`);
    return r.result;
  };
  const scores = observe.scores ? await get<RawScores[]>("scores") : undefined;
  const blocks: RawBlock[] = [];
  for (const b of observe.blocks ?? []) {
    const [from, to] = blockRange(b);
    blocks.push(...await get<RawBlock[]>("blocks", { from, to }));
  }
  const entities = observe.entityTags ? await get<RawEntity[]>("entities") : undefined;
  return normalizeBedrock(observe, { ...(scores ? { scores } : {}), blocks, ...(entities ? { entities } : {}) }, mapBlock);
}

/** 統合版のワールド一覧で見分けられるよう、変換前の Java ワールドの名前を変える */
function renameJavaWorld(world: string, name: string): void {
  const file = join(world, "level.dat");
  const root = readNbt(gunzipSync(readFileSync(file)), "java");
  const data = root.tag.type === "compound" ? root.tag.value.get("Data") : undefined;
  if (data?.type !== "compound") throw new Error("level.dat に Data がない");
  data.value.set("LevelName", { type: "string", value: name } as NbtTag);
  writeFileSync(file, gzipSync(writeNbt({ name: root.name, tag: root.tag }, "java")));
}

function check(label: string, java: NormalizedState, bedrock: NormalizedState, required: string[], known: Record<string, string> = {}): void {
  const result = assessComparison(java, bedrock, required, known);
  const unexpected = unexpectedDiffs(result, known);
  console.log(`${label}: ${JSON.stringify({ required: result.required, incomparable: result.incomparable.length, completeMatch: result.completeMatch })}`);
  expect(result.passed, `${label}: 必須観測の不足・比較不能・差分\n${JSON.stringify(result.checks)}`).toBe(true);
  expect(unexpected, `${label}: 説明のない差分\n${formatDiffs(unexpected)}`).toEqual([]);
}

async function runPlaytest(p: Playtest, known: Record<string, string> | undefined, mapBlock: BedrockBlockMapper) {
  const work = mkdtempSync(join(paths.servers, "playtest-"));
  try {
    // ---- Java：組み立てて保存し、同じセッションのままボタンを押す ----
    const java = await JavaServer.start();
    const log: string[] = [];
    let javaButtons: NormalizedState;
    let javaState: NormalizedState;
    try {
      await java.exec("tick freeze");
      await javaAction(java, { run: SPAWN }, log);
      for (const c of p.setup) await javaAction(java, { run: c }, log);
      for (const a of p.actions) await javaAction(java, a, log);
      javaButtons = await observeJava(java, p.buttonObserve);
      await java.dump({});
      cpSync(join(paths.javaServer, "je2be-test"), join(work, "java"), { recursive: true });
      for (const step of p.steps) {
        await javaAction(java, { run: `setblock ${step.button.pos.join(" ")} ${javaButton(step.button, true)}` }, log);
        await javaTicks(java, step.ticks);
      }
      javaState = await observeJava(java, p.observe);
    } finally {
      await java.stop();
    }
    renameJavaWorld(join(work, "java"), `je2be ${basename(p.id)}`);

    // ---- 変換：利用者と同じ CLI で .mcworld を作る ----
    const archive = join(work, `${basename(p.id)}.mcworld`);
    const result = JSON.parse(execFileSync(process.execPath, [cli, "convert", join(work, "java"), "--out", archive], { encoding: "utf8", timeout: 600_000 })) as { report: string; status: string };
    expect(result.status).toBe("partial");
    const loaded = join(work, "loaded");
    mkdirSync(loaded);
    execFileSync("unzip", ["-q", archive, "-d", loaded]);

    // ---- BE：変換後のワールドを設定補助なしで開き、同じ順にボタンを押す ----
    const bds = await BedrockServer.start({ world: loaded, worldSettings: "preserve" });
    let bedrockButtons: NormalizedState;
    let bedrockState: NormalizedState;
    try {
      await bds.waitForLog((l) => l.includes(INIT_LOG_MARK), 30_000, "init pack");
      bedrockButtons = await observeBedrock(bds, p.buttonObserve, mapBlock);
      for (const step of p.steps) {
        const command = `setblock ${step.button.pos.join(" ")} ${bedrockButton(step.button, true)}`;
        const res = await bds.exec(command);
        if (!res.ok) throw new Error(`bedrock: ${command}: ${res.error}`);
        await waitBedrockTicks(bds, step.ticks);
      }
      bedrockState = await observeBedrock(bds, p.observe, mapBlock);
    } finally {
      await bds.stop();
    }
    return { work, archive, report: result.report, javaButtons, javaState, bedrockButtons, bedrockState, log };
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

const tables = JSON.parse(readFileSync(join(paths.servers, "mappings", "mappings.json"), "utf8")) as MappingTables;
const geyser = geyserBlockMapper(tables);
const mapBlock: BedrockBlockMapper = (type, states) => geyser(type, states) ?? minimalBlockMapper(type, states);

describe("playtest maps", () => {
  for (const s of loadScenarios().filter((x) => x.play)) {
    it(`${s.id}: buttons survive conversion and pressing them matches Java`, async () => {
      const p = toPlaytest(s);
      const golden = readGolden(s);
      if (!golden) throw new Error(`${s.id}: 正解データがない`);
      const r = await runPlaytest(p, s.knownDiffs, mapBlock);
      try {
        // 作り替えで意味が変わっていない：Java で押した結果が、元のシナリオの正解データと同じ
        expect(r.javaState, `${s.id}: ボタンでの操作が元のシナリオと違う\n${r.log.join("\n")}`).toEqual(golden.state);
        check(`${s.id} buttons`, r.javaButtons, r.bedrockButtons, ["blocks"]);
        check(`${s.id} pressed`, r.javaState, r.bedrockState, p.requiredObservations, s.knownDiffs);
        const target = process.env.JE2BE_ACCEPTANCE_ARTIFACTS;
        if (target) {
          mkdirSync(target, { recursive: true });
          cpSync(r.archive, join(target, basename(r.archive)), { force: false, errorOnExist: true });
          cpSync(r.report, join(target, `${basename(p.id)}.report.json`), { force: false, errorOnExist: true });
        }
      } finally {
        rmSync(r.work, { recursive: true, force: true });
      }
    }, 600_000);
  }
});
