// 実際に生成した 26.2 / 26.3 の文法で正規化を比較する。
import { expect, it } from "vitest";
import { CommandParser, normalize1_21_2Arguments, normalize26_3DataArgumentNames, toCommandIR } from "@je2be/core";
import { javaGrammarSources, loadGrammarTree, setupJavaGrammar } from "@je2be/converter";

it("normalizes the 26.2 data and function coordinate paths parsed with generated grammars", async () => {
  const sources = javaGrammarSources();
  const grammars = await Promise.all(["26.2", "26.3"].map(version => {
    const source = sources.find(s => s.version === version);
    if (!source) throw new Error(`Missing grammar ${version}`);
    return setupJavaGrammar(source);
  }));
  const parsers = grammars.map(g => new CommandParser(loadGrammarTree(g), { textFormat: g.textFormat }));
  for (const command of [
    "data modify block 1 2 3 foo set from block 4 5 6",
    "execute if data block 1 2 3 foo run say hello",
    "execute store result block 1 2 3 foo int 1 run say hello",
    "function test:foo with block 1 2 3",
  ]) {
    const old = parsers[0]!.parse(command), current = parsers[1]!.parse(command);
    if (!old.ok || !current.ok) throw new Error(`Could not parse ${command}: ${JSON.stringify({ old, current })}`);
    expect(normalize26_3DataArgumentNames(toCommandIR(command, old.nodes))).toEqual(toCommandIR(command, current.nodes));
  }
});


it("normalizes 1.21.1 advancement, recipe and experience using generated grammars", async () => {
  const sources = javaGrammarSources();
  const grammars = await Promise.all(["1.21.1", "1.21.2"].map(version => {
    const source = sources.find(s => s.version === version);
    if (!source) throw new Error(`Missing grammar ${version}`);
    return setupJavaGrammar(source);
  }));
  const parsers = grammars.map(g => new CommandParser(loadGrammarTree(g), { textFormat: g.textFormat }));
  for (const command of ["advancement grant @a only minecraft:story/root", "recipe give @a minecraft:stone", "experience add @a 3", "xp add @a 3"]) {
    const old = parsers[0]!.parse(command), current = parsers[1]!.parse(command);
    if (!old.ok || !current.ok) throw new Error(`Could not parse ${command}: ${JSON.stringify({ old, current })}`);
    expect(normalize1_21_2Arguments(toCommandIR(command, old.nodes))).toEqual(toCommandIR(command, current.nodes));
  }
});
