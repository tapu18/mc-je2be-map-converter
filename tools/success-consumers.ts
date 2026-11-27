// 成否を後段が使い、同期評価できない委譲の命令を配布マップで数える（#168、#93 の判断2の材料）。
// 使い方:
//   node tools/success-consumers.ts <sample-map または ZIP ...> [--json <出力先>]
//
// ZIP を一時ディレクトリに展開し（ワールドの level.dat・region・datapacks・data だけ）、変換器と同じ
// collectDatapacks と prepareWorldCommands でチェーンを振り分ける。原本は読むだけで変更しない。
// 出力は作品の連番（ZIP 名の昇順、0 起点。scripts/dump_commands.py と同じ）ごとの件数だけ。
// コマンドの文面・作品名は出さない（権利上、公開しない）。
//
// 数えるもの（定義は docs/research/success-consumers.md）:
// - チェーン: 変換器の振り分け（native / runtime / unsupported）。unsupported のうち理由が
//   「#93 の判断待ち」のものが、後段（条件付きブロック・execute store・if function）が同期評価できない
//   委譲の成否を使うチェーン。他の理由で先に止まったチェーンは、後段の構造を持つかを上限として別に数える。
// - コンパレーター: コマンドブロックの入力側に接したもの。ランタイムに移す（runtime・判断待ち）チェーンの
//   ブロックを読み、そのブロックの末尾命令が委譲になるものを数える。
// - データパック: 関数の行のうち、委譲になる末尾命令の成否・結果を execute store / return run が使う行と、
//   execute if|unless function の行。tick・load からは書き込み可能な文脈で動き、BE の successCount が
//   同期で得られる（値が Java と一致するかは未確認）。関数をまたぐ推移的な依存は数えない（未集計）。
import AdmZip from "adm-zip";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommandParser, blockAt, commandBlocksInChunk, deserializeCommandIR, runtimeFamilies, selectCommandGrammar, toCommandIR,
  type BlockDefaults, type CommandBlockInfo, type CommandIR, type MappingTables,
} from "@je2be/core";
import { DEFAULT_CHUNKER_FORMAT, JavaWorld, fixedJavaDataVersion, loadBlockDefaults, loadGrammarTree, loadJavaGrammars, prepareWorldCommands } from "@je2be/converter";
import { collectDatapacks } from "../packages/converter/src/datapacks.ts";
import { terrainCommandMappings } from "../packages/converter/src/chunker-block-mappings.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixed = JSON.parse(readFileSync(join(root, "tools", "servers.json"), "utf8")) as { java: { version: string }; chunker: { version: string } };
const reports = join(root, "servers", `reports-${fixed.java.version}`, "reports");
const res = { commandsJson: join(reports, "commands.json"), blocksJson: join(reports, "blocks.json"), mappingsJson: join(root, "servers", "mappings", "mappings.json") };
const chunkerJar = join(root, "servers", "tools", `chunker-cli-${fixed.chunker.version}.jar`);
const pendingDecision = "#93 の判断待ち: 同期評価できない委譲の成否を後段が参照する";

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
if (!args.length) throw new Error("usage: node tools/success-consumers.ts <sample-map または ZIP ...> [--json <出力先>]");
const inputs = args;
const zips = inputs.flatMap(input => statSync(input).isDirectory()
  ? readdirSync(input).filter(name => name.toLowerCase().endsWith(".zip")).sort().map(name => join(input, name)) : [input]);

const grammars = loadJavaGrammars();
const tables = JSON.parse(readFileSync(res.mappingsJson, "utf8")) as MappingTables;
const mappings = terrainCommandMappings(tables, chunkerJar, DEFAULT_CHUNKER_FORMAT);

type Tally = Record<string, number>;
const add = (tally: Tally, key: string, n = 1) => { tally[key] = (tally[key] ?? 0) + n; };

/** Keep only world data and reject unsafe names. Embedded world ZIPs are searched one level deep. */
function extractWorlds(zip: AdmZip, work: string, depth = 0): string[] {
  const entries = zip.getEntries();
  const roots = entries.map(e => e.entryName).filter(n => n === "level.dat" || n.endsWith("/level.dat")).map(n => n.slice(0, -"level.dat".length));
  const worlds: string[] = [];
  for (const [index, prefix] of roots.entries()) {
    const target = join(work, `world-${depth}-${worlds.length}-${index}`);
    mkdirSync(target);
    for (const entry of entries) {
      const name = entry.entryName;
      if (entry.isDirectory || !name.startsWith(prefix)) continue;
      const rel = name.slice(prefix.length);
      const parts = rel.split("/");
      if (parts.some(p => !p || p === "." || p === "..") || rel.includes("\\") || rel.includes(":")) continue;
      if (!(rel === "level.dat" || /(^|\/)region\/r\.-?\d+\.-?\d+\.mca$/.test(rel) || rel.startsWith("datapacks/") || rel.startsWith("data/") || /^dimensions\/[^/]+\/[^/]+\/data\//.test(rel))) continue;
      const file = join(target, ...parts);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, entry.getData(), { flag: "wx" });
    }
    worlds.push(target);
  }
  if (!roots.length && depth === 0) {
    for (const entry of entries) if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith(".zip")) {
      const child = new AdmZip(entry.getData());
      if (child.getEntries().some(e => e.entryName.endsWith("level.dat"))) worlds.push(...extractWorlds(child, work, depth + 1));
    }
  }
  return worlds;
}

const facings = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] } as const;
/** Comparators whose input side touches the block. JE comparator `facing` points toward its input (scripts/survey_corpus.py). */
function comparatorsReading(world: JavaWorld, block: CommandBlockInfo, defaults: BlockDefaults | undefined): number {
  let count = 0;
  for (const [facing, [dx, , dz]] of Object.entries(facings)) {
    const [x, y, z] = [block.pos[0] - dx, block.pos[1], block.pos[2] - dz];
    const chunk = world.chunk(block.dimension, Math.floor(x / 16), Math.floor(z / 16));
    const state = chunk && blockAt(chunk, x, y, z, defaults);
    if (state?.name === "minecraft:comparator" && state.properties.facing === facing) count++;
  }
  return count;
}

const coreEvaluated = (ir: CommandIR) => runtimeFamilies.some(family => family.assess({ status: "parsed", ir }).status === "runtime");
/** The terminal command after unwrapping `return run`, classified as the runtime would run it. */
function terminalKind(ir: CommandIR): "none" | "core" | "function" | "delegated" {
  let terminal = ir;
  while (terminal.command?.name === "return" && terminal.command.run) terminal = terminal.command.run;
  if (!terminal.command) return "none";
  if (terminal.command.name === "function") return "function";
  if (terminal.command.name === "return") return "core";
  return coreEvaluated(terminal) ? "core" : "delegated";
}
function consumers(ir: CommandIR) {
  return {
    store: ir.context.some(step => step.kind === "store"),
    ifFunction: ir.context.some(step => (step.kind === "if" || step.kind === "unless") && step.nodes[0]?.name === "function"),
    returnRun: ir.command?.name === "return" && ir.command.run !== undefined,
  };
}

interface MapResult { worlds: number; noGrammar: number; chains: Tally; datapack: Tally; reasons: Tally; commands: Tally }
const results: MapResult[] = [];

for (const [mapIndex, zipPath] of zips.entries()) {
  const result: MapResult = { worlds: 0, noGrammar: 0, chains: {}, datapack: {}, reasons: {}, commands: {} };
  results.push(result);
  const work = mkdtempSync(join(tmpdir(), "je2be-168-"));
  try {
    for (const dir of extractWorlds(new AdmZip(zipPath), work)) {
      result.worlds++;
      const world = new JavaWorld(dir);
      const dataVersion = world.dataVersion();
      const selected = dataVersion === undefined ? undefined : selectCommandGrammar(grammars, { dataVersion });
      const grammar = selected?.ok ? selected.grammar : undefined;
      if (!grammar) result.noGrammar++;
      const parser = grammar && new CommandParser(loadGrammarTree(grammar), grammar);
      const defaults = loadBlockDefaults(grammar && grammar.dataVersion !== fixedJavaDataVersion ? join(dirname(grammar.commandsPath), "blocks.json") : res.blocksJson);
      const parse = (source: string): CommandIR | undefined => {
        const parsed = parser?.parse(source.trim().replace(/^\//, ""));
        return parsed?.ok ? toCommandIR(source.trim().replace(/^\//, ""), parsed.nodes) : undefined;
      };

      // Read original blocks before prepareWorldCommands rewrites the scratch copy.
      const blocks = new Map<string, CommandBlockInfo>();
      for (const dimension of world.dimensions()) for (const chunk of world.chunks(dimension)) {
        for (const block of commandBlocksInChunk(chunk, dimension, defaults)) blocks.set(`${dimension} ${block.pos.join(",")}`, block);
      }
      const comparators = new Map<string, number>();
      for (const [key, block] of blocks) {
        const n = comparatorsReading(world, block, defaults);
        if (n) comparators.set(key, n);
      }

      const datapacks = collectDatapacks(dir, { mappings, blocksJson: res.blocksJson });
      const datapackData = { schemaVersion: 1 as const, packs: datapacks.packs };
      const prepared = prepareWorldCommands(dir, res, mappings, { datapacks: datapackData, nativeCommands: datapacks.nativeCommands });
      // Blocks absent from the report kept their command unchanged, so BE can run them.
      const notRewritable = new Set(prepared.report.commandBlocks.filter(entry => entry.status === "unsupported" || entry.status === "invalid")
        .map(entry => `${entry.dimension} ${entry.pos.join(",")}`));

      for (const chain of prepared.report.chains) {
        const members = chain.blocks.map(pos => blocks.get(`${chain.head.dimension} ${pos.join(",")}`)!);
        const pending = chain.status === "unsupported" && chain.reason === pendingDecision;
        const category = pending ? "pending" : chain.status;
        add(result.chains, `${category}.chains`);
        add(result.chains, `${category}.blocks`, members.length);
        if (chain.status === "unsupported" && !pending) add(result.reasons, chain.reason.split(/[:：]/)[0]!.replace(/\d+/g, "N"));
        // A consumer reads the producer's success: the next conditional block, its own store / if function /
        // return run, or a comparator. The producer's terminal decides whether the runtime can evaluate it.
        let structure = false, potential = false, potentialNative = false, viaFunction = false;
        const parsed = members.map(block => block.command.trim() ? parse(block.command) : undefined);
        for (const [index, block] of members.entries()) {
          const ir = parsed[index];
          const kind = ir ? terminalKind(ir) : block.command.trim() ? "unparsed" : "empty";
          const c = ir ? consumers(ir) : undefined;
          const next = members[index + 1]?.conditional ?? false;
          if (next) add(result.chains, `${category}.conditionalBlocks`);
          if (c?.store) add(result.chains, `${category}.storeBlocks`);
          if (c?.ifFunction) add(result.chains, `${category}.ifFunctionBlocks`);
          if (c?.returnRun) add(result.chains, `${category}.returnRunBlocks`);
          const comparator = comparators.get(`${block.dimension} ${block.pos.join(",")}`) ?? 0;
          if (comparator) add(result.chains, `${category}.comparators.${kind}`, comparator);
          const consumed = next || !!c?.store || !!c?.returnRun || comparator > 0;
          structure ||= consumed || !!c?.ifFunction;
          if (consumed && (kind === "delegated" || kind === "unparsed")) {
            potential = true;
            add(result.chains, `${category}.delegatedConsumed.blocks`);
            if (!notRewritable.has(`${block.dimension} ${block.pos.join(",")}`)) potentialNative = true;
            let terminal = ir;
            while (terminal?.command?.name === "return" && terminal.command.run) terminal = terminal.command.run;
            add(result.commands, `${category}.${terminal?.command?.name ?? "unparsed"}`);
            if (comparator) add(result.chains, `${category}.delegatedConsumed.comparators`, comparator);
          }
          if (c?.ifFunction || consumed && kind === "function") viaFunction = true;
        }
        const head = members[0]!;
        if (category !== "native") add(result.chains, `${category}.head.${head.kind ?? "unknown"}${head.auto ? ".auto" : ""}`);
        for (const [flag, name] of [[structure, "withConsumer"], [potential, "delegatedConsumed"], [potentialNative, "delegatedConsumed.rewritable"], [viaFunction, "viaFunction"]] as const) {
          if (!flag) continue;
          add(result.chains, `${category}.${name}.chains`);
          add(result.chains, `${category}.${name}.chainBlocks`, members.length);
        }
      }

      // Effective functions after pack overrides (as loadDatapacks does), without requiring valid tags.
      const functions = new Map<string, string[]>();
      for (const pack of datapackData.packs) for (const [id, lines] of Object.entries(pack.functions)) functions.set(id, lines);
      const native = new Map(datapacks.nativeCommands);
      for (const lines of functions.values()) {
        let functionHas = false;
        for (const line of lines) {
          add(result.datapack, "lines");
          const decoded = deserializeCommandIR(line);
          if (!decoded.ok) { add(result.datapack, "undecodable"); continue; }
          const ir = decoded.document.ir;
          if (ir.macro) { add(result.datapack, "macroLines"); continue; }
          const c = consumers(ir);
          const kind = terminalKind(ir);
          const count = (key: string) => {
            add(result.datapack, `${key}.${kind}`);
            if (kind !== "delegated") return;
            const rewritable = native.get(ir.source) ? "rewritable" : "unsupported";
            add(result.datapack, `${key}.delegated.${rewritable}`);
            let terminal = ir;
            while (terminal.command?.name === "return" && terminal.command.run) terminal = terminal.command.run;
            add(result.commands, `datapack.${rewritable}.${terminal.command?.name}`);
          };
          if (c.store) count("store");
          if (c.returnRun) count("returnRun");
          if (c.ifFunction) add(result.datapack, "ifFunction");
          if ((c.store || c.returnRun) && kind === "delegated" && native.get(ir.source)) functionHas = true;
        }
        add(result.datapack, "functions");
        if (functionHas) add(result.datapack, "functionsWithDelegatedConsumer");
      }
    }
  } catch (error) {
    add(result.reasons, `作品の読み込み失敗: ${String(error).split("\n")[0]!.slice(0, 80)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.error(`map ${mapIndex}: done`);
}

const total: MapResult = { worlds: 0, noGrammar: 0, chains: {}, datapack: {}, reasons: {}, commands: {} };
for (const r of results) {
  total.worlds += r.worlds; total.noGrammar += r.noGrammar;
  for (const field of ["chains", "datapack", "reasons", "commands"] as const) for (const [k, v] of Object.entries(r[field])) add(total[field], k, v);
}
const output = { maps: results.map((r, map) => ({ map, ...r })), total };
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(output, null, 2) + "\n");
const g = (t: Tally, k: string) => t[k] ?? 0;
const pair = (c: Tally, k: string) => `${g(c, `${k}.chains`)}（${g(c, `${k}.chainBlocks`)}）`;
console.log("| 作品 | ワールド | 判断待ち | ランタイム移行 | ランタイム移行のうち委譲の成否を使う | 他理由で対象外 | 他理由のうちランタイム外の命令の成否を使う | うち BE に書き換えられる命令 | 他理由のうち関数経由 | 移行・対象外の比較器（ランタイム外） | 関数: 委譲の成否を store・return run が使う行（関数） | 関数: BE にもない命令の成否を使う行 | if function 行 |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [map, r] of [...results.entries(), ["全体", total] as const]) {
  const c = r.chains, d = r.datapack;
  const cells = [
    `${r.worlds}${r.noGrammar ? `（文法なし ${r.noGrammar}）` : ""}`,
    `${g(c, "pending.chains")}（${g(c, "pending.blocks")}）`,
    `${g(c, "runtime.chains")}（${g(c, "runtime.blocks")}）`,
    pair(c, "runtime.delegatedConsumed"),
    `${g(c, "unsupported.chains")}（${g(c, "unsupported.blocks")}）`,
    pair(c, "unsupported.delegatedConsumed"),
    pair(c, "unsupported.delegatedConsumed.rewritable"),
    pair(c, "unsupported.viaFunction"),
    String(["pending", "runtime", "unsupported"].reduce((n, k) => n + g(c, `${k}.delegatedConsumed.comparators`), 0)),
    `${g(d, "store.delegated.rewritable") + g(d, "returnRun.delegated.rewritable")}（${g(d, "functionsWithDelegatedConsumer")}）`,
    String(g(d, "store.delegated.unsupported") + g(d, "returnRun.delegated.unsupported")),
    String(g(d, "ifFunction")),
  ];
  console.log(`| ${map} | ${cells.join(" | ")} |`);
}
