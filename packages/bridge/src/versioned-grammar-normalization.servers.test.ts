import { expect, it } from "vitest";
import {
  normalize1_21Attribute, normalize1_21_2Arguments, normalize1_21_9SpawnRotation,
  normalize1_21_11Worldborder, normalize26_1Time, normalize26_2TeamColor,
  normalize26_3DataArgumentNames, normalize26_3Schedule, toCommandIR,
  type ArgumentValue, type CommandIR, type CommandTreeNode, type ParsedNode,
} from "@je2be/core";
import { javaGrammarSources, loadGrammarTree, setupJavaGrammar } from "@je2be/converter";

// 各比較で、その境界の実装だけを適用する。
const NORMALIZERS = new Map<string, (ir: CommandIR) => CommandIR>([
  ["1.20.6→1.21", normalize1_21Attribute],
  ["1.21.1→1.21.2", normalize1_21_2Arguments],
  ["1.21.8→1.21.9", normalize1_21_9SpawnRotation],
  ["1.21.10→1.21.11", normalize1_21_11Worldborder],
  ["1.21.11→26.1", normalize26_1Time],
  ["26.1→26.2", normalize26_2TeamColor],
  ["26.2→26.3", ir => {
    const renamed = normalize26_3DataArgumentNames(ir);
    const schedule = normalize26_3Schedule(renamed);
    if (!schedule.ok) throw new Error(schedule.reason);
    return schedule.ir;
  }],
]);

// 値で分岐する部品に、その型の代表値を渡す。比較するのは引数の名前と型。
const VALUES: Record<string, ArgumentValue> = {
  "minecraft:uuid": { kind: "word", value: "00000000-0000-0000-0000-000000000001" },
  "minecraft:angle": { kind: "coordinates", coordinates: [{ kind: "relative", value: 15 }] },
  "brigadier:integer": { kind: "number", value: 7 },
  "brigadier:string": { kind: "string", value: "test:example" },
};

function signature(nodes: ParsedNode[]): string {
  return nodes.map(node => node.kind === "literal" ? node.name : `<${node.name}:${node.parser}>`).join(" ");
}

function literalPath(nodes: ParsedNode[]): string {
  return nodes.filter(node => node.kind === "literal").map(node => node.name).join(" ");
}

function commandPaths(tree: CommandTreeNode): Map<string, ParsedNode[]> {
  const paths = new Map<string, ParsedNode[]>();
  const visit = (node: CommandTreeNode, path: ParsedNode[]): void => {
    if (node.executable || node.redirect) paths.set(signature(path), path);
    for (const [name, child] of Object.entries(node.children ?? {})) {
      const kind = child.type === "argument" ? "argument" : "literal";
      const parser = child.parser;
      const value = parser ? VALUES[parser] : undefined;
      visit(child, [...path, { kind, name, ...(parser ? { parser } : {}), ...(value ? { value } : {}), start: 0, end: 0 }]);
    }
  };
  visit(tree, []);
  return paths;
}

function normalizedSignature(path: ParsedNode[], normalize: (ir: CommandIR) => CommandIR): string {
  const ir = normalize(toCommandIR("", path));
  const head = path[0]!;
  if (head.name === "execute") {
    return [head.name, ...ir.context.map(step => `${step.kind} ${signature(step.nodes)}`)].join(" ").trimEnd();
  }
  return ir.command ? signature([head, ...ir.command.nodes]) : signature(path);
}

const OUT_OF_SCOPE: Record<string, string> = {
  // LAN への公開設定は配布ワールドの変換対象外。
  "- publish <allowCommands:brigadier:bool> <gamemode:minecraft:gamemode>": "LAN 公開",
  "- publish <allowCommands:brigadier:bool> <gamemode:minecraft:gamemode> <port:brigadier:integer>": "LAN 公開",
  "+ publish <allowCommands:brigadier:bool> <port:brigadier:integer>": "LAN 公開",
  // 既存の swing に追加された新構文。旧版入力には対応する引数がない。
  "+ swing <targets:minecraft:entity> mainhand <animation:minecraft:swing_animation>": "26.3 で追加",
  "+ swing <targets:minecraft:entity> mainhand <animation:minecraft:swing_animation> <duration:minecraft:time>": "26.3 で追加",
  "+ swing <targets:minecraft:entity> offhand <animation:minecraft:swing_animation>": "26.3 で追加",
  "+ swing <targets:minecraft:entity> offhand <animation:minecraft:swing_animation> <duration:minecraft:time>": "26.3 で追加",
};

it("accounts for argument name/type changes between adjacent Java command reports", async () => {
  const grammars = [];
  for (const source of javaGrammarSources()) grammars.push(await setupJavaGrammar(source));
  grammars.sort((a, b) => a.dataVersion - b.dataVersion);

  const unhandled: Record<string, string[]> = {};
  for (let index = 1; index < grammars.length; index++) {
    const old = grammars[index - 1]!, current = grammars[index]!;
    const boundary = `${old.version}→${current.version}`;
    if (boundary === "1.20.4→1.20.5") continue; // #191 の担当範囲。
    const before = commandPaths(loadGrammarTree(old));
    const after = commandPaths(loadGrammarTree(current));
    const oldLiterals = new Set([...before.values()].map(literalPath));
    const newLiterals = new Set([...after.values()].map(literalPath));
    const normalize = NORMALIZERS.get(boundary);
    const added = new Map([...after].filter(([key]) => !before.has(key)));
    const removed: string[] = [];

    for (const [key, path] of before) {
      if (after.has(key)) continue;
      const normalized = normalize && normalizedSignature(path, normalize);
      if (normalized && after.has(normalized)) {
        added.delete(normalized);
      } else if (newLiterals.has(literalPath(path))) {
        removed.push(`- ${key}`);
      }
    }
    // 引数の挿入・削除も拾う。リテラル経路ごとの新設・廃止は比較の範囲外。
    const remaining = [...removed, ...[...added]
      .filter(([, path]) => oldLiterals.has(literalPath(path)))
      .map(([key]) => `+ ${key}`)];
    if (remaining.length) unhandled[boundary] = remaining.sort();
  }
  expect(unhandled).toEqual({ "26.2→26.3": Object.keys(OUT_OF_SCOPE).sort() });
});
