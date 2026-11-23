// 正解データのシナリオ（scenarios/）を両エディションで実行して比べる（#38）。
//
// - Java：正解データ（<名前>.java.json）と一致するかを確かめる。JE2BE_RECORD=1 のときは記録し直す。
//   正解データがないときは記録する（CI では失敗にする。正解データはコミットしておくこと）。
// - BE：正解データと比べる。シナリオの knownDiffs にない差分があれば失敗。knownDiffs にあるのに差分がなければ、
//   古い記載として失敗にする（直ったら消す）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths, repoRoot } from "../paths.ts";
import { assessComparison, formatDiffs, unexpectedDiffs } from "./compare.ts";
import { loadScenarios, readGolden, writeGolden } from "./load.ts";
import { runBedrock, runJava } from "./run.ts";

const servers = JSON.parse(readFileSync(join(repoRoot, "tools/servers.json"), "utf8")) as { java: { version: string } };
const version = process.env.JE2BE_JAVA_VERSION;
if (version && !/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error("Invalid Java version");
const grammar = version ? JSON.parse(readFileSync(join(paths.servers, "grammars", version, "grammar.json"), "utf8")) as { version: string; packFormat: number; packMinor: number; source: { functionDirectory: "function" | "functions" } } : undefined;
if (grammar && grammar.version !== version) throw new Error("Java version mismatch");
const runtime = grammar ? { runtime: { java: paths.java, serverDirectory: join(paths.servers, "grammars", version!, "server") }, packFormat: grammar.packFormat, packMinor: grammar.packMinor, functionDirectory: grammar.source.functionDirectory } : undefined;
const record = process.env.JE2BE_RECORD === "1";
const ci = process.env.CI === "true";

const scenarios = loadScenarios();
const selection = process.env.JE2BE_SCENARIO_IDS;
const ids: string[] = selection ? JSON.parse(selection) : [];
const selected = selection ? scenarios.filter(({ id }) => ids.includes(id)) : scenarios;
if (selection && (!ids.length || selected.length !== ids.length)) throw new Error("Invalid scenario selection");

for (const s of selected) {
  describe(`scenario ${s.id}`, () => {
    it("java matches the golden data", async () => {
      const { state, log } = await runJava(s, runtime);
      const golden = readGolden(s, undefined, version);
      if (record || !golden) {
        if (!golden && ci) throw new Error(`${s.id}: 正解データがない。JE2BE_RECORD=1 で記録してコミットすること`);
        writeGolden(s, { java: version ?? servers.java.version, state }, undefined, version);
        return;
      }
      expect(state, `Java の結果が正解データと違う（Java のバージョンが変わったなら記録し直す）\n${log.join("\n")}`).toEqual(golden.state);
    });

    if (version) return; // 版別の記録は Java のみ

    if (s.bedrockPending) {
      it.skip(`bedrock 未実行（${s.bedrockPending}）`, () => {});
      return;
    }

    it("bedrock matches the golden data", async () => {
      const golden = readGolden(s);
      if (!golden) throw new Error(`${s.id}: 正解データがない`);
      const { state, log } = await runBedrock(s);
      if (s.play && !s.requiredObservations?.length) throw new Error(`${s.id}: 変換の受け入れ確認には requiredObservations が必要`);
      const result = assessComparison(golden.state, state, s.requiredObservations, s.knownDiffs);
      const unexpected = unexpectedDiffs(result, s.knownDiffs);
      const stale = Object.keys(s.knownDiffs ?? {}).filter((p) => !result.diffs.some((d) => d.path === p));
      if (result.incomparable.length) console.log(`${s.id}: 比べられなかった値（ID 対応なし）\n  ${result.incomparable.join("\n  ")}`);
      console.log(`${s.id}: ${JSON.stringify({ required: result.required, knownDifferences: result.diffs.length - unexpected.length, incomparable: result.incomparable.length, completeMatch: result.completeMatch })}`);
      expect(result.passed, `必須観測の不足・比較不能・差分\n${JSON.stringify(result.checks)}`).toBe(true);
      expect(unexpected, `説明のない差分\n${formatDiffs(unexpected)}\n${log.join("\n")}`).toEqual([]);
      expect(stale, "knownDiffs にあるが、もう差分がない（消すこと）").toEqual([]);
    });
  });
}
