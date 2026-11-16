// 旧 JE の文法検証用サーバーを別枠で取得する。BE と固定 Java の版は変更しない。
import { javaGrammarSources, setupJavaGrammar } from "@je2be/converter";

const versions = process.argv.slice(2);
const sources = javaGrammarSources();
for (const version of versions) if (!sources.some((s) => s.version === version)) throw new Error(`unknown pinned Java version: ${version}`);
for (const source of sources.filter((s) => versions.length === 0 || versions.includes(s.version))) {
  const grammar = await setupJavaGrammar(source);
  console.log(JSON.stringify({ version: grammar.version, dataVersion: grammar.dataVersion, packFormat: grammar.packFormat, packMinor: grammar.packMinor, commands: grammar.commandsPath }));
}
