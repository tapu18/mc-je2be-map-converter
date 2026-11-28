import {
  commandBlockBehind, commandBlockLinks, compileModifier, entityNbtRejection, normalizeCommandIR, rewriteCommand, rewriteNativeCommand, runtimeFamilies, serializeCommandIR, toCommandIR,
  type CommandBlockInfo, type CommandIR, type RewriteContext, type RuntimeChain, type RuntimeState, type TextFormat,
} from "@je2be/core";

type Site = Pick<CommandBlockInfo, "dimension" | "pos">;
type NonemptyChain = [CommandBlockInfo, ...CommandBlockInfo[]];

export type ChainDecision = {
  head: Site;
  blocks: CommandBlockInfo["pos"][];
  status: "native" | "runtime" | "unsupported";
  reason: string;
  at?: Site;
  launcherId?: string;
};

type ChainGroup = { blocks: NonemptyChain; reason?: string };

/** Include orphan components so a loop or a join from an orphan cannot be missed. */
export function groupCommandChains(blocks: readonly CommandBlockInfo[]): ChainGroup[] {
  const links = commandBlockLinks(blocks);
  const incoming = new Map<CommandBlockInfo, CommandBlockInfo[]>();
  for (const [from, to] of links) {
    const sources = incoming.get(to);
    if (sources) sources.push(from);
    else incoming.set(to, [from]);
  }

  const visited = new Set<CommandBlockInfo>();
  const groups: ChainGroup[] = [];
  for (const block of blocks) {
    if (visited.has(block)) continue;
    const component: NonemptyChain = [block];
    visited.add(block);
    for (const current of component) {
      const neighbors = [...(incoming.get(current) ?? []), links.get(current)];
      for (const neighbor of neighbors) {
        if (!neighbor || visited.has(neighbor)) continue;
        visited.add(neighbor);
        component.push(neighbor);
      }
    }
    const root = component.find(candidate => candidate.kind !== "chain");
    const join = component.some(candidate => (incoming.get(candidate)?.length ?? 0) > 1);
    const noSource = component.every(candidate => incoming.has(candidate));
    // With at most one outgoing edge, a join can also lead into a cycle.
    const first = root ?? block;
    const path = new Set([first]);
    const ordered: NonemptyChain = [first];
    let cursor = links.get(first);
    while (cursor && !path.has(cursor)) {
      path.add(cursor);
      ordered.push(cursor);
      cursor = links.get(cursor);
    }
    const reasons = [
      ...(join ? ["合流"] : []),
      ...(cursor || noSource ? ["ループ"] : []),
      ...(!root && !cursor && !noSource ? ["起動できる先頭がない"] : []),
      ...(component.some(candidate => !candidate.kind || !candidate.facing) ? ["種類または向きが不明"] : []),
    ];
    groups.push(reasons.length
      ? { blocks: [first, ...component.filter(candidate => candidate !== first)], reason: `チェーンの構成が未対応: ${reasons.join("、")}` }
      : { blocks: ordered });
  }
  return groups;
}

const pendingDecision = "#93 の判断待ち: 同期評価できない委譲の成否を後段が参照する";
// Mirror the production host's capabilities. Java block reads, loaded checks and heightmaps are not available.
const host = { entities: () => [], readBlock: () => undefined };

export function compileRuntimeChain(
  blocks: NonemptyChain,
  ctx: RewriteContext,
  grammarVersion: string,
  textFormat: TextFormat,
  functions: RuntimeState,
  datapackNative: ReadonlyMap<string, string>,
): { chain: RuntimeChain } | { at: Site; reason: string } {
  const delegates = new Map<string, string>();
  const fromDatapack = (source: string) => datapackNative.get(source);
  const fromBlock = (source: string) => {
    const converted = rewriteNativeCommand(source, ctx);
    return converted.status === "unchanged" || converted.status === "rewritten" ? converted.command : undefined;
  };
  const unsupportedStep = (ir: CommandIR) => ir.context.find(step => !compileModifier(step, host)
    || ((step.kind === "if" || step.kind === "unless") && ["block", "blocks"].includes(step.nodes[0]?.name ?? "")));

  function assess(
    ir: CommandIR,
    consumes: boolean,
    resolve: (source: string) => string | undefined,
    stack: Set<string>,
  ): string | undefined {
    if (ir.macro) return "呼び出し先のマクロ命令は静的に判定できない";
    const unsupported = unsupportedStep(ir);
    if (unsupported) return `ランタイムで未対応の execute ${unsupported.kind} ${unsupported.nodes[0]?.name ?? ""}`.trimEnd();
    for (const step of ir.context) {
      if (["if", "unless"].includes(step.kind) && step.nodes[0]?.name === "function") {
        const reason = assessFunction(step.nodes[1]?.value, true, stack);
        if (reason) return reason;
      }
    }
    consumes ||= ir.context.some(step => step.kind === "store");
    const command = ir.command;
    if (!command) return;
    if (command.name === "function") return assessFunction(command.nodes[0]?.value, consumes, stack);
    if (command.name === "return") return command.run && assess(command.run, consumes, resolve, stack);
    if (runtimeFamilies.some(family => family.assess({ status: "parsed", ir }).status === "runtime")) return;

    const rejection = entityNbtRejection(ir);
    if (rejection) return rejection;
    const native = resolve(ir.source);
    if (native === undefined) return `ランタイム実行・BE への委譲ともに未対応: ${command.name}`;
    if (consumes) return pendingDecision;
    const previous = delegates.get(ir.source);
    if (previous !== undefined && previous !== native) return "同一の命令に複数の BE への委譲先がある";
    delegates.set(ir.source, native);
  }

  function assessFunction(target: CommandIR["context"][number]["nodes"][number]["value"], consumes: boolean, stack: Set<string>): string | undefined {
    const ids = target?.kind === "resource" ? (target.tag ? functions.functionTags.get(target.id) : [target.id]) : undefined;
    if (!ids) return "呼び出し先の関数・タグが見つからない";
    for (const id of ids) {
      const lines = functions.functions.get(id);
      if (!lines) return `呼び出し先の関数が見つからない: ${id}`;
      if (stack.has(id)) return `再帰する関数の成否は静的に判定できない: ${id}`;
      if (stack.size >= 128) return "関数呼び出しがランタイムの深さ制限を超える";
      stack.add(id);
      for (const line of lines) {
        const reason = assess(line, consumes, fromDatapack, stack);
        if (reason) return reason;
      }
      stack.delete(id);
    }
  }

  for (const [index, block] of blocks.entries()) {
    const previous = blocks[index - 1];
    if (!previous || !block.conditional) continue;
    const at = { dimension: block.dimension, pos: block.pos };
    const behind = commandBlockBehind(block);
    if (!behind?.every((v, axis) => v === previous.pos[axis])) return { at, reason: "条件付きブロックが実行順の直前以外の成否を参照する" };
    if (index > 1 && !previous.auto) return { at, reason: "条件付きブロックがレッドストーン待ちのブロックに残る成否を参照する" };
  }

  const steps: RuntimeChain["blocks"] = [];
  for (const [index, block] of blocks.entries()) {
    const at = { dimension: block.dimension, pos: block.pos };
    const step = { pos: block.pos, facing: block.facing!, conditional: block.conditional, auto: block.auto };
    const source = block.command.trim();
    if (!source) { steps.push(step); continue; }
    const parsed = ctx.parser.parse(source);
    if (!parsed.ok) return { at, reason: `Java コマンドを解析できない: ${parsed.error.message}` };
    const normalized = normalizeCommandIR(toCommandIR(source, parsed.nodes), grammarVersion);
    if (!normalized.ok) return { at, reason: normalized.reason };
    const consumes = blocks[index + 1]?.conditional ?? false;
    let native: string | undefined;
    if (unsupportedStep(normalized.ir)) {
      const translated = rewriteCommand(source, ctx);
      if (translated.status === "rewritten" || translated.status === "unchanged") {
        if (consumes) return { at, reason: pendingDecision };
        native = translated.command;
      }
    }
    if (native === undefined) {
      const reason = assess(normalized.ir, consumes, fromBlock, new Set());
      if (reason) return { at, reason };
    }
    try {
      const command = serializeCommandIR({ grammarVersion, textFormat, ir: normalized.ir });
      steps.push({ ...step, command, ...(native === undefined ? {} : {native}) });
    } catch (error) {
      return { at, reason: `変換済み IR をパックに格納できない: ${String(error)}` };
    }
  }
  return { chain: { dimension: blocks[0].dimension, blocks: steps, nativeCommands: [...delegates] } };
}
