// ランタイムの確定世代が、強制終了・save hold・大容量の動的プロパティでどう残るかを BDS で測る（#200）。
// 実行: npm run build:pack && node poc/state-durability/measure.ts（数分。結果は results.json）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BedrockServer, paths } from "@je2be/bridge";
import { CommandParser, serializeCommandIR, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { writeInitPack } from "../../packages/converter/src/convert.ts";
import { addRuntimeProbe, probe } from "../../packages/bridge/src/runtime-probe.ts";

const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
const ir = (source: string) => {
  const parsed = parser.parse(source);
  if (!parsed.ok) throw Error(source);
  return serializeCommandIR({grammarVersion: "26.3", textFormat: "snbt", ir: toCommandIR(source, parsed.nodes)});
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Scores = Record<string, number>;

/** `#restored` is the runtime tick of the restored generation; `#loads` counts load runs in it. */
async function withServer<T>(run: (start: () => Promise<BedrockServer>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(paths.servers, "state-durability-"));
  const functions = {
    "test:load": ["scoreboard players add #loads clock 1", "scoreboard players operation #restored clock = #tick clock"].map(ir),
    "test:tick": ["scoreboard players add #tick clock 1"].map(ir),
  };
  writeInitPack(dir, [{objective: "clock", scores: [{participant: "#tick", score: 0}]}], [], JSON.stringify({schemaVersion: 1, packs: [{
    functions, tags: {"minecraft:load": {values: ["test:load"]}, "minecraft:tick": {values: ["test:tick"]}},
  }]}));
  const pack = join(dir, "behavior_packs", "je2be_init");
  addRuntimeProbe(pack);
  try { return await run(() => BedrockServer.start({behaviorPacks: [pack], tickingArea: false})); }
  finally { rmSync(dir, {recursive: true, force: true}); }
}
async function scores(bds: BedrockServer): Promise<Scores> {
  const {result} = await bds.request<{objective: string; scores: {participant: string; score: number}[]}[]>("scores");
  return Object.fromEntries(result!.find(row => row.objective === "clock")!.scores.map(s => [s.participant, s.score]));
}
const runtimeErrors = (bds: BedrockServer) => bds.log.filter(line => line.includes("[je2be]") && !line.includes("[je2be] initialized"));

const results: Record<string, unknown> = {date: new Date().toISOString()};

// 1. SIGKILL after running for a while, without any explicit save.
results.killWithoutSave = await withServer(async start => {
  let bds = await start();
  results.bedrock = bds.log.find(line => line.includes("Version: "))?.replace(/.*Version: /, "");
  const trials = [];
  try {
    for (const wait of [1000, 5000, 15000, 40000, 70000]) {
      await sleep(wait);
      const before = await scores(bds);
      bds = await bds.restart({kill: true});
      await sleep(1000);
      trials.push({waitMs: wait, before, after: await scores(bds), errors: runtimeErrors(bds)});
    }
  } finally { await bds.stop(); }
  return trials;
});

// 2. `save hold` / `save query` / `save resume`, then SIGKILL.
const saveHold = [];
for (const [waitMs, restartedFirst] of [[1000, false], [10000, false], [30000, false], [1000, true], [10000, true]] as const) {
  saveHold.push(await withServer(async start => {
    let bds = await start();
    try {
      if (restartedFirst) { await sleep(2000); bds = await bds.restart(); }
      await sleep(waitMs);
      const atHold = await scores(bds);
      bds.console("save hold");
      bds.console("save query");
      await bds.waitForLog(line => line.includes("Files are now ready to be copied"), 30_000, "save query");
      bds.console("save resume");
      await sleep(3000);
      const before = await scores(bds);
      bds = await bds.restart({kill: true});
      await sleep(1500);
      return {waitMs, restartedFirst, atHold, before, after: await scores(bds), errors: runtimeErrors(bds)};
    } finally { await bds.stop(); }
  }));
}
results.saveHoldThenKill = saveHold;

// 3. Total dynamic-property volume: 4,000 values of 32,767 bytes, then a graceful restart.
results.volume = await withServer(async start => {
  let bds = await start();
  try {
    const batches = [];
    for (let from = 0; from < 4000; from += 500) {
      const started = Date.now();
      const bytes = await probe<number>(bds, "fill", {from, to: from + 500, char: "x", length: 32767}, 120_000);
      batches.push({values: from + 500, totalBytes: bytes, ms: Date.now() - started});
    }
    bds = await bds.restart();
    return {batches, afterRestart: {totalBytes: await probe(bds, "bytes"), wrongValues: await probe(bds, "check", {from: 0, to: 4000, length: 32767}, 120_000), scores: await scores(bds)}};
  } finally { await bds.stop(); }
});

writeFileSync(new URL("results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
