// ホスト層の実機確認（#200）：保存・再起動・強制終了をまたぐ状態の復元と、マクロ付き関数。
// 中核の意味論は Node のテスト（macro.data.test.ts、schedule.data.test.ts、persistence.test.ts）で確かめる。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BedrockServer, paths } from "@je2be/bridge";
import {
  CommandParser, compileMacroTemplate, parseSnbt, serializeCommandIR, serializeStorage, toCommandIR, type CommandTreeNode,
} from "@je2be/core";
import { writeInitPack } from "../../converter/src/convert.ts";
import { addRuntimeProbe, probe } from "../../bridge/src/runtime-probe.ts";

const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
const BIG = 100_000;

function encode(source: string): string {
  if (source.startsWith("$")) {
    const template = compileMacroTemplate(parser, source, "26.3");
    if (!template.ok) throw Error(`${source}: ${template.reason}`);
    return serializeCommandIR({grammarVersion: "26.3", textFormat: "snbt", ir: template.ir});
  }
  const parsed = parser.parse(source);
  if (!parsed.ok) throw Error(`${source}: ${parsed.error.message}`);
  return serializeCommandIR({grammarVersion: "26.3", textFormat: "snbt", ir: toCommandIR(source, parsed.nodes)});
}

let dir: string;
let bds: BedrockServer | undefined;
beforeEach(() => { dir = mkdtempSync(join(paths.servers, "runtime-restart-")); });
afterEach(async () => {
  await bds?.stop();
  bds = undefined;
  rmSync(dir, {recursive: true, force: true});
});

/** Write the runtime pack with the given functions, an initial 100 KB storage value and the probe entry. */
function writePack(scripts: Record<string, string[]>, objectives: string[] = ["clock"]): string {
  const functions = Object.fromEntries(Object.entries(scripts).map(([id, lines]) => [id, lines.map(encode)]));
  const tags = Object.fromEntries(["load", "tick"].filter(tag => `test:${tag}` in scripts)
    .map(tag => [`minecraft:${tag}`, {values: [`test:${tag}`]}]));
  const big = parseSnbt(`{v:"${"x".repeat(BIG)}"}`);
  if (big.type !== "compound") throw Error("storage must be a compound");
  writeInitPack(dir, objectives.map(objective => ({objective, scores: [{participant: "#tick", score: 0}]})), [],
    JSON.stringify({schemaVersion: 1, packs: [{functions, tags}]}),
    JSON.stringify([{id: "test:big", chunks: [serializeStorage(big)]}]));
  const pack = join(dir, "behavior_packs", "je2be_init");
  addRuntimeProbe(pack);
  return pack;
}

async function clock(server: BedrockServer): Promise<Record<string, number>> {
  const {result} = await server.request<{objective: string; scores: {participant: string; score: number}[]}[]>("scores");
  return Object.fromEntries(result?.find(row => row.objective === "clock")?.scores.map(s => [s.participant, s.score]) ?? []);
}
const tickAbove = (server: BedrockServer, value: number) =>
  expect.poll(async () => (await clock(server))["#tick"] ?? 0, {timeout: 30_000}).toBeGreaterThan(value);
const runtimeLog = (server: BedrockServer) => server.log.filter(line => line.includes("[je2be]") && !line.includes("[je2be] initialized"));
const commitMarker = async (server: BedrockServer) =>
  JSON.parse((await probe<string[]>(server, "get", {keys: ["je2be:state:commit"]}))[0]!) as
    {generation: number; entries: {kind: string; id: string; generation: number; slot: number; chunks: number}[]};

const RESTORE = {
  "test:load": [
    "scoreboard players add #loads clock 1",
    "execute store result score #restored clock run scoreboard players get #tick clock",
    "execute store result score #big clock run data get storage test:big v",
    "execute if score #loads clock matches 1 run schedule function test:later 100t",
  ],
  "test:later": ["scoreboard players operation #later clock = #tick clock"],
  "test:tick": ["scoreboard players add #tick clock 1"],
};

it("runs macro functions on BDS and reports instantiation failures in the content log", async () => {
  bds = await BedrockServer.start({tickingArea: false, behaviorPacks: [writePack({
    "test:load": [
      'function test:macro {holder:"m",score:7}',
      'function test:macro {holder:"a b",score:1}',
      "function test:macro {score:2}",
      'data modify storage test:args value set value {holder:"s",score:9}',
      "function test:macro with storage test:args value",
    ],
    "test:macro": ["$scoreboard players set #$(holder) clock $(score)"],
    "test:tick": ["scoreboard players add #tick clock 1"],
  })]});
  await tickAbove(bds, 0);
  expect(await clock(bds)).toMatchObject({"#m": 7, "#s": 9});
  expect(await clock(bds)).not.toHaveProperty(["#a b"]);
  // Script の console.warn は content-log-console-output-enabled のコンテンツログに [Scripting] として出る。
  const failures = runtimeLog(bds);
  expect(failures).toEqual([
    expect.stringMatching(/WARN\] \[Scripting\] \[je2be\] function test:macro: .*/),
    expect.stringContaining("[Scripting] [je2be] function test:macro: missing macro argument 'holder'"),
  ]);
});

it("restores scores, a multi-chunk storage value and a pending schedule across graceful restarts", async () => {
  bds = await BedrockServer.start({tickingArea: false, behaviorPacks: [writePack(RESTORE)]});
  await tickAbove(bds, 0);
  const first = await clock(bds);
  expect(first).toMatchObject({"#loads": 1, "#restored": 0, "#big": BIG});
  // The 100t schedule is still pending when the server stops.
  expect(first["#tick"]).toBeLessThan(90);
  expect(first).not.toHaveProperty("#later");
  const big = (await commitMarker(bds)).entries.find(entry => entry.kind === "storage" && entry.id === "test:big");
  expect(big?.chunks).toBe(4);

  bds = await bds.restart();
  await expect.poll(async () => (await clock(bds!))["#later"], {timeout: 30_000}).toBeDefined();
  const second = await clock(bds);
  expect(second["#restored"]).toBeGreaterThanOrEqual(first["#tick"]!);
  // A schedule made during the first load runs in tick 100, before the tick tag adds the 100th tick.
  expect(second).toMatchObject({"#loads": 2, "#big": BIG, "#later": 99});

  bds = await bds.restart();
  await tickAbove(bds, second["#tick"]!);
  expect(await clock(bds)).toMatchObject({"#loads": 3, "#big": BIG, "#later": 99});
  expect(runtimeLog(bds)).toEqual([]);
});

it("restores a consistent committed generation after SIGKILL and ignores uncommitted chunks", async () => {
  bds = await BedrockServer.start({tickingArea: false, behaviorPacks: [writePack(RESTORE)]});
  await tickAbove(bds, 20);
  // Chunks of a generation that was never committed, as a write interrupted before the marker would leave.
  const orphan = (await commitMarker(bds)).generation + 1_000_000;
  const orphans = [`je2be:state:${orphan}:0:0`, `je2be:state:${orphan}:7:3`];
  await probe(bds, "set", {entries: [[orphans[0], "{broken"], [orphans[1], "]"]]});
  const stopped = (await clock(bds))["#tick"]!;
  bds = await bds.restart();
  await tickAbove(bds, stopped);
  expect(await clock(bds)).toMatchObject({"#loads": 2, "#big": BIG});
  expect(await probe<string[]>(bds, "keys", {prefix: `je2be:state:${orphan}:`})).toEqual(orphans);

  // SIGKILL loses commits since BDS last wrote dynamic properties; when that happens is not under the runtime's control.
  let loads = 2;
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const killed = (await clock(bds))["#tick"]!;
    bds = await bds.restart({kill: true});
    await tickAbove(bds, 0);
    const restored = await clock(bds);
    expect(restored["#restored"]).toBeLessThanOrEqual(killed);
    expect(restored["#restored"]).toBeGreaterThanOrEqual(stopped);
    expect(restored["#loads"]).toBeGreaterThanOrEqual(2);
    expect(restored["#loads"]).toBeLessThanOrEqual(loads + 1);
    expect(restored["#big"]).toBe(BIG);
    expect(runtimeLog(bds)).toEqual([]);
    loads = restored["#loads"]!;
  }
});

it("stops with an explicit error when a committed chunk is missing, before and after restart", async () => {
  bds = await BedrockServer.start({tickingArea: false, behaviorPacks: [writePack(RESTORE)]});
  await tickAbove(bds, 0);
  const big = (await commitMarker(bds)).entries.find(entry => entry.kind === "storage" && entry.id === "test:big")!;
  await probe(bds, "set", {entries: [[`je2be:state:${big.generation}:${big.slot}:1`, null]]});
  const stopped = await bds.waitForLog(line => line.includes("[je2be] tick stopped"), 10_000, "tick stop");
  expect(stopped).toContain(`state persistence failed: Error: missing state chunk ${big.generation}/${big.slot}/1`);

  bds = await bds.restart();
  const failed = await bds.waitForLog(line => line.includes("[je2be] initialization failed"), 30_000, "initialization failure");
  expect(failed).toContain(`missing state chunk ${big.generation}/${big.slot}/1`);
  // The broken state is neither reset to the initial data nor partially loaded: load does not run again.
  await new Promise(resolve => setTimeout(resolve, 2000));
  expect(await clock(bds)).toMatchObject({"#loads": 1});
});

it("rejects a state index larger than one dynamic property instead of truncating it", async () => {
  const objectives = Array.from({length: 600}, (_, i) => `o${i}`);
  bds = await BedrockServer.start({tickingArea: false, behaviorPacks: [writePack({"test:tick": []}, objectives)]});
  const failed = await bds.waitForLog(line => line.includes("[je2be] initialization failed"), 30_000, "initialization failure");
  expect(failed).toContain("state index exceeds dynamic property capacity");
  expect(await probe<string[]>(bds, "get", {keys: ["je2be:state:commit"]})).toEqual([null]);
});
