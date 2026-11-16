// 各リリースの実サーバーと文法パーサを突き合わせる。ゲームデータは git 管理外で生成する。
import { describe, expect, it } from "vitest";
import { ARGUMENT_PARSERS, CommandParser, selectCommandGrammar } from "@je2be/core";
import { javaGrammarSources, loadGrammarTree, setupJavaGrammar } from "@je2be/converter";
import { checkJavaSyntax } from "./java-syntax.ts";

const CASES = [
  "say hello", 'tellraw @a {"text":"x"}',
  'tellraw @a {text:"x"}', "tellraw @a {text:'x'}", 'tellraw @a {text:"x",bold:1b}',
  'tellraw @a ["x",{text:"y"}]',
  "gamerule keepInventory true", "gamerule keep_inventory true",
  "team modify t color blue", "team modify t color reset", "team modify t color bold",
  "setworldspawn 0 64 0 ~15", "setworldspawn 0 64 0 90 0",
  String.raw`tellraw @a {"text":"a\/b"}`,
];

describe("versioned command grammars", () => {
  for (const source of javaGrammarSources()) {
    it(`matches Java ${source.version}, including text, gamerules, angles and colors`, async () => {
      const grammar = await setupJavaGrammar(source);
      const tree = loadGrammarTree(grammar);
      const parser = new CommandParser(tree, { textFormat: grammar.textFormat });
      const types = new Set<string>();
      const visit = (node: typeof tree): void => {
        if (node.parser) types.add(node.parser);
        for (const child of Object.values(node.children ?? {})) visit(child);
      };
      visit(tree);
      expect([...types].filter((type) => !ARGUMENT_PARSERS[type])).toEqual([]);
      const actual = await checkJavaSyntax(CASES, { runtime: {
        java: grammar.java, serverDirectory: grammar.serverDirectory, packFormat: grammar.packFormat,
        packMinor: grammar.packMinor, functionDirectory: grammar.source.functionDirectory,
      } });
      // 全17版の実サーバーとの比較で確認した、安定リリースでの変更境界。
      const snbt = !["1.20.5", "1.20.6", "1.21", "1.21.1", "1.21.2", "1.21.3", "1.21.4"].includes(source.version);
      const modernRule = ["1.21.11", "26.1", "26.2", "26.3"].includes(source.version);
      const rotation = modernRule || ["1.21.9", "1.21.10"].includes(source.version);
      const expected = [true, true, snbt, snbt, snbt, snbt, !modernRule, modernRule, true, true, false, !rotation, rotation, !snbt];
      expect(actual.map((r) => r.ok), JSON.stringify(actual)).toEqual(expected);
      expect(CASES.map((command) => parser.parse(command).ok)).toEqual(expected);
      expect(selectCommandGrammar([grammar], { dataVersion: grammar.dataVersion })).toMatchObject({ ok: true, grammar: { version: source.version } });
      expect(selectCommandGrammar([grammar], { packFormat: grammar.packFormat })).toMatchObject({ ok: true });
    });
  }
});
