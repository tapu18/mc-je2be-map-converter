// Java ワールドのコマンドブロックのコマンドを BE の書き方に書き換える（#62、design.md 5.3・5.10）。
// Chunker はコマンド文字列を変えずに運ぶ（docs/findings.md）ため、Chunker に渡す前の Java ワールド（のコピー）を書き換える。
// BE のコマンド1個にできないものは元のまま残し、レポートに出す（チェーンごとランタイムで実行するのは M2）。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  blockEntities,
  child,
  CommandParser,
  MappingLookup,
  rewriteCommand,
  rewriteRegion,
  selectCommandGrammar,
  textFormatFor,
  type CommandTreeNode,
  type MappingTables,
  type NbtCompound,
  type RewriteContext,
  type RewriteIssue,
  type RewriteResult,
  type TextFormat,
} from "@je2be/core";
import { loadBlockDefaults } from "./block-defaults.ts";
import { fixedJavaDataVersion, loadGrammarTree, loadJavaGrammars } from "./java-grammars.ts";
import { decompress, JavaWorld } from "./java-world.ts";

export interface RewriteResources {
  /** 固定サーバー（tools/servers.json）の commands.json */
  commandsJson: string;
  /** データ生成の blocks.json */
  blocksJson: string;
  /** Geyser の対応表（npm run setup:mappings の mappings.json） */
  mappingsJson: string;
}

/** 書き換えに使う文法・対応表を読む。textFormat はワールドの DataVersion から決める */
export function loadRewriteContext(res: RewriteResources, textFormat: TextFormat): RewriteContext {
  const tree = JSON.parse(readFileSync(res.commandsJson, "utf8")) as CommandTreeNode;
  return rewriteContext(tree, textFormat, res.mappingsJson, res.blocksJson);
}

function rewriteContext(tree: CommandTreeNode, textFormat: TextFormat, mappingsJson: string, blocksJson: string): RewriteContext {
  const tables = JSON.parse(readFileSync(mappingsJson, "utf8")) as MappingTables;
  return { parser: new CommandParser(tree, { textFormat }), mappings: new MappingLookup(tables), blockDefaults: loadBlockDefaults(blocksJson) };
}

function worldRewriteContext(res: RewriteResources, dataVersion: number | undefined): RewriteContext | undefined {
  if (dataVersion === fixedJavaDataVersion) return loadRewriteContext(res, textFormatFor(dataVersion));
  if (dataVersion === undefined) return undefined;
  const selection = selectCommandGrammar(loadJavaGrammars(), { dataVersion });
  if (!selection.ok) return undefined;
  const grammar = selection.grammar;
  return rewriteContext(loadGrammarTree(grammar), grammar.textFormat, res.mappingsJson, join(dirname(grammar.commandsPath), "blocks.json"));
}

export interface CommandBlockRewrite {
  dimension: string;
  pos: [number, number, number];
  /** 元の Java のコマンド */
  java: string;
  status: RewriteResult["status"];
  /** 書き込んだ BE のコマンド（unsupported・invalid では元のまま残したので undefined） */
  bedrock?: string;
  issues: RewriteIssue[];
  /** invalid のときの Java の文法の誤り */
  error?: string;
}

export interface CommandRewriteReport {
  textFormat: TextFormat;
  counts: Record<RewriteResult["status"], number>;
  /** unchanged 以外（書き換えた、書き換えられなかった、警告つき） */
  commandBlocks: CommandBlockRewrite[];
}

const num = (t: ReturnType<typeof child>): number => (t && typeof t.value === "number" ? t.value : NaN);

/**
 * Java ワールド（ディレクトリ）のコマンドブロックを、その場で書き換える。元のワールドを残したいときはコピーに対して呼ぶ。
 * 空のコマンドは対象にしない
 */
export function rewriteWorldCommands(javaDir: string, res: RewriteResources): CommandRewriteReport {
  const world = new JavaWorld(javaDir);
  const dataVersion = world.dataVersion();
  const textFormat = textFormatFor(dataVersion);
  const ctx = worldRewriteContext(res, dataVersion);
  const unavailable: RewriteResult = {
    status: "unsupported",
    issues: [{ severity: "unsupported", message: `DataVersion ${dataVersion ?? "不明"} の文法がない。npm run setup:grammars で対象版を生成する` }],
  };
  const counts: CommandRewriteReport["counts"] = { rewritten: 0, unchanged: 0, unsupported: 0, invalid: 0 };
  const commandBlocks: CommandBlockRewrite[] = [];
  for (const dimension of world.dimensions()) {
    const dir = join(world.dimensionDir(dimension), "region");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".mca")).sort()) {
      const file = join(dir, name);
      const out = rewriteRegion(new Uint8Array(readFileSync(file)), decompress, (d) => new Uint8Array(deflateSync(d)), (chunk) => {
        let changed = false;
        for (const be of blockEntities(chunk)) {
          const id = child(be, "id");
          const cmd = child(be, "Command");
          if (id?.type !== "string" || id.value !== "minecraft:command_block" || cmd?.type !== "string" || !cmd.value.trim()) continue;
          const r = ctx ? rewriteCommand(cmd.value, ctx) : unavailable;
          counts[r.status]++;
          const pos: [number, number, number] = [num(child(be, "x")), num(child(be, "y")), num(child(be, "z"))];
          const entry: CommandBlockRewrite = { dimension, pos, java: cmd.value, status: r.status, issues: r.status === "invalid" ? [] : r.issues };
          if (r.status === "invalid") entry.error = `${r.message}（${r.position}文字目）`;
          if (r.status === "rewritten" || r.status === "unchanged") {
            entry.bedrock = r.command;
            if (r.command !== cmd.value) {
              (be as NbtCompound).value.set("Command", { type: "string", value: r.command });
              changed = true;
            }
          }
          if (r.status !== "unchanged" || entry.issues.length) commandBlocks.push(entry);
        }
        return changed ? chunk : undefined;
      });
      if (out) writeFileSync(file, out);
    }
  }
  return { textFormat, counts, commandBlocks };
}
