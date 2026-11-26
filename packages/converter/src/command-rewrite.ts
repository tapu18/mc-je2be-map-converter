// Java ワールドのコマンドブロックのコマンドを BE の書き方に書き換える（#62、design.md 5.3・5.10）。
// Chunker はコマンド文字列を変えずに運ぶ（docs/findings.md）ため、Chunker に渡す前の Java ワールド（のコピー）を書き換える。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  blockEntities,
  child,
  chainLaunchPrefix,
  commandBlocksInChunk,
  CommandParser,
  loadDatapacks,
  MappingLookup,
  nbt,
  rewriteCommand,
  rewriteRegion,
  selectCommandGrammar,
  textFormatFor,
  RuntimeState,
  type CommandBlockInfo,
  type Datapacks,
  type CommandTreeNode,
  type MappingTables,
  type ParseOptions,
  type RewriteContext,
  type RewriteIssue,
  type RewriteResult,
  type RuntimeChain,
  type TextFormat,
} from "@je2be/core";
import { loadBlockDefaults } from "./block-defaults.ts";
import { fixedJavaDataVersion, fixedJavaVersion, loadGrammarTree, loadJavaGrammars, parseCommandTree } from "./java-grammars.ts";
import { decompress, JavaWorld } from "./java-world.ts";
import { compileRuntimeChain, groupCommandChains, type ChainDecision } from "./command-chains.ts";

export interface RewriteResources {
  /** 固定サーバー（tools/servers.json）の commands.json */
  commandsJson: string;
  /** データ生成の blocks.json */
  blocksJson: string;
  /** Geyser の対応表（npm run setup:mappings の mappings.json） */
  mappingsJson: string;
}

/** 書き換えに使う文法・対応表を読む。textFormat はワールドの DataVersion から決める */
export function loadRewriteContext(res: RewriteResources, textFormat: TextFormat, mappings = loadRewriteMappings(res)): RewriteContext {
  const tree = parseCommandTree(readFileSync(res.commandsJson, "utf8"));
  return rewriteContext(tree, { textFormat }, mappings, res.blocksJson);
}

function loadRewriteMappings(res: RewriteResources): MappingLookup {
  return new MappingLookup(JSON.parse(readFileSync(res.mappingsJson, "utf8")) as MappingTables);
}

function rewriteContext(tree: CommandTreeNode, options: ParseOptions, mappings: MappingLookup, blocksJson: string): RewriteContext {
  return { parser: new CommandParser(tree, options), mappings, blockDefaults: loadBlockDefaults(blocksJson) };
}

function worldRewriteContext(res: RewriteResources, dataVersion: number | undefined, mappings?: MappingLookup): { ctx: RewriteContext; version: string } | undefined {
  if (dataVersion === fixedJavaDataVersion) return { ctx: loadRewriteContext(res, textFormatFor(dataVersion), mappings), version: fixedJavaVersion };
  if (dataVersion === undefined) return undefined;
  const selection = selectCommandGrammar(loadJavaGrammars(), { dataVersion });
  if (!selection.ok) return undefined;
  const grammar = selection.grammar;
  return { ctx: rewriteContext(loadGrammarTree(grammar), grammar, mappings ?? loadRewriteMappings(res), join(dirname(grammar.commandsPath), "blocks.json")), version: grammar.version };
}

export interface CommandBlockRewrite {
  dimension: string;
  pos: [number, number, number];
  /** 元の Java のコマンド */
  java: string;
  status: RewriteResult["status"];
  /** 実際に書き込んだ BE のコマンド。無効化した後続では空文字列。 */
  bedrock?: string;
  issues: RewriteIssue[];
  /** invalid のときの Java の文法の誤り */
  error?: string;
}

export interface CommandRewriteReport {
  textFormat: TextFormat;
  /** 先に試みた BE コマンド単体への書き換えの集計。最終的な振り分けは chains。 */
  counts: Record<RewriteResult["status"], number>;
  /** ネイティブ書き換えの結果、警告とランタイムへの差し替え */
  commandBlocks: CommandBlockRewrite[];
  chains: ChainDecision[];
}

const num = (t: ReturnType<typeof child>): number => (t && typeof t.value === "number" ? t.value : NaN);
const key = (dimension: string, pos: number[]) => `${dimension} ${pos.join(",")}`;

/**
 * Java ワールド（ディレクトリ）のコマンドブロックを、その場で書き換える。元のワールドを残したいときはコピーに対して呼ぶ。
 * パックを作らない呼び出しではコマンド単位の書き換えだけを適用する。
 */
export function rewriteWorldCommands(javaDir: string, res: RewriteResources, mappings?: MappingLookup): CommandRewriteReport {
  return prepareWorldCommands(javaDir, res, mappings).report;
}

export function prepareWorldCommands(javaDir: string, res: RewriteResources, mappings?: MappingLookup, runtime?: {
  datapacks: Datapacks;
  nativeCommands: [string, string][];
}): { report: CommandRewriteReport; runtimeChains: Record<string, RuntimeChain> } {
  const world = new JavaWorld(javaDir);
  const dataVersion = world.dataVersion();
  const textFormat = textFormatFor(dataVersion);
  const grammar = worldRewriteContext(res, dataVersion, mappings);
  const ctx = grammar?.ctx;
  const unavailable: RewriteResult = {
    status: "unsupported",
    issues: [{ severity: "unsupported", message: `DataVersion ${dataVersion ?? "不明"} の文法がない。npm run setup:grammars で対象版を生成する` }],
  };
  const counts: CommandRewriteReport["counts"] = { rewritten: 0, unchanged: 0, unsupported: 0, invalid: 0 };
  const commandBlocks: CommandBlockRewrite[] = [];
  const chains: ChainDecision[] = [];
  const runtimeChains: Record<string, RuntimeChain> = {};
  const functions = new RuntimeState();
  let packUnavailable = "ランタイムパックを生成しない呼び出し";
  if (runtime) {
    try { loadDatapacks(functions, runtime.datapacks); }
    catch (error) {
      // Invalid pack data already prevents host initialization. Do not emit launchers for it.
      packUnavailable = `ランタイムパックを初期化できない: ${String(error)}`;
      runtime = undefined;
    }
  }
  const datapackNative = new Map(runtime?.nativeCommands);
  const blocks: CommandBlockInfo[] = [];
  const dimensions = world.dimensions();
  for (const dimension of dimensions) for (const chunk of world.chunks(dimension)) {
    blocks.push(...commandBlocksInChunk(chunk, dimension, ctx?.blockDefaults));
  }
  const results = new Map<string, { entry: CommandBlockRewrite; replacement?: string; disable?: boolean }>();
  const rewritten = new Map<string, RewriteResult>();
  for (const block of blocks) {
    if (!block.command.trim()) continue;
    const source = block.command;
    let r = rewritten.get(source);
    if (!r) {
      r = ctx ? rewriteCommand(source, ctx) : unavailable;
      rewritten.set(source, r);
    }
    counts[r.status]++;
    const entry: CommandBlockRewrite = { dimension: block.dimension, pos: block.pos, java: block.command, status: r.status, issues: r.status === "invalid" ? [] : r.issues };
    if (r.status === "invalid") entry.error = `${r.message}（${r.position}文字目）`;
    const native = r.status === "rewritten" || r.status === "unchanged" ? r.command : undefined;
    if (native !== undefined) entry.bedrock = native;
    results.set(key(block.dimension, block.pos), { entry, ...(native === undefined ? {} : { replacement: native }) });
  }
  for (const group of groupCommandChains(blocks)) {
    const [first] = group.blocks;
    const head = { dimension: first.dimension, pos: first.pos };
    const sites = group.blocks.map(block => block.pos);
    const unsupported = group.blocks.find(block => {
      const status = results.get(key(block.dimension, block.pos))?.entry.status;
      return status === "unsupported" || status === "invalid";
    });
    if (group.reason) {
      chains.push({ head, blocks: sites, status: "unsupported", reason: group.reason });
    } else if (!unsupported) {
      chains.push({ head, blocks: sites, status: "native", reason: "全コマンドを BE コマンドとして保持できる" });
    } else if (!grammar || !runtime) {
      chains.push({ head, blocks: sites, status: "unsupported", reason: !grammar
        ? unavailable.issues[0]!.message
        : packUnavailable });
    } else if (!["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"].includes(first.dimension)) {
      chains.push({ head, blocks: sites, status: "unsupported", reason: "ランタイムで未対応のディメンション" });
    } else {
      const result = compileRuntimeChain(group.blocks, grammar.ctx, grammar.version, textFormat, functions, datapackNative);
      if ("reason" in result) {
        chains.push({ head, blocks: sites, status: "unsupported", reason: result.reason, at: result.at });
        continue;
      }
      const launcherId = `${chainLaunchPrefix}${chains.length}`;
      runtimeChains[launcherId] = result.chain;
      chains.push({ head, blocks: sites, status: "runtime", launcherId,
        reason: "BE コマンド 1 個に変換できない命令があり、チェーン全体をランタイムで実行する",
        at: { dimension: unsupported.dimension, pos: unsupported.pos } });
      for (const [index, block] of group.blocks.entries()) {
        const location = key(block.dimension, block.pos);
        const replacement = index === 0 ? `je2be:run "${launcherId}" ~ ~ ~ ^ ^ ^1 ${block.dimension}` : "";
        const entry = results.get(location)?.entry ?? { dimension: block.dimension, pos: block.pos, java: block.command, status: "unchanged", issues: [] };
        results.set(location, { entry: { ...entry, bedrock: replacement }, replacement, disable: index > 0 });
      }
    }
  }
  for (const dimension of dimensions) {
    const dir = join(world.dimensionDir(dimension), "region");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".mca")).sort()) {
      const file = join(dir, name);
      const out = rewriteRegion(new Uint8Array(readFileSync(file)), decompress, (d) => new Uint8Array(deflateSync(d)), (chunk) => {
        let changed = false;
        for (const be of blockEntities(chunk)) {
          const id = child(be, "id");
          const cmd = child(be, "Command");
          if (id?.type !== "string" || id.value !== "minecraft:command_block") continue;
          const pos = [num(child(be, "x")), num(child(be, "y")), num(child(be, "z"))];
          const result = results.get(key(dimension, pos));
          if (!result) continue;
          const { entry, replacement, disable } = result;
          if (replacement !== undefined && replacement !== cmd?.value) {
            be.value.set("Command", nbt.string(replacement));
            changed = true;
          }
          if (disable) {
            be.value.set("auto", nbt.byte(0));
            be.value.set("powered", nbt.byte(0));
            be.value.set("SuccessCount", nbt.int(0));
            changed = true;
          }
          if (entry.status !== "unchanged" || entry.issues.length || replacement !== undefined && replacement !== entry.java || disable) commandBlocks.push(entry);
        }
        return changed ? chunk : undefined;
      });
      if (out) writeFileSync(file, out);
    }
  }
  return { report: { textFormat, counts, commandBlocks, chains }, runtimeChains };
}
