// Generate local-only measurement inputs; Mojang data and generated packs are not committed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const scripts = new URL("./pack/scripts/", import.meta.url);
mkdirSync(scripts, { recursive: true });
for (const name of ["parser", "arguments", "reader", "snbt"]) {
  const source = readFileSync(new URL(`../../packages/core/src/command/${name}.ts`, import.meta.url), "utf8");
  const js = stripTypeScriptTypes(source).replaceAll('.ts"', '.js"');
  writeFileSync(new URL(`${name}.js`, scripts), js);
}
const grammar = readFileSync(new URL("../../servers/reports-26.3/reports/commands.json", import.meta.url), "utf8");
const mappings = readFileSync(new URL("../../servers/mappings/mappings.json", import.meta.url), "utf8");
writeFileSync(new URL("data.js", scripts), `export const grammarText = ${JSON.stringify(grammar)};\nexport const mappingsText = ${JSON.stringify(mappings)};\n`);
writeFileSync(new URL("main.js", scripts), `import { CommandParser } from './parser.js';\nimport { grammarText, mappingsText } from './data.js';\nconst start = Date.now();\nconst grammar = JSON.parse(grammarText);\nconst mappings = JSON.parse(mappingsText);\nconst loaded = Date.now();\nconst result = new CommandParser(grammar, { textFormat: 'snbt' }).parse('scoreboard players set example test 1');\nconsole.log('RUNTIME_LOAD ' + JSON.stringify({ start, loaded, end: Date.now(), ok: result.ok, mappingKeys: Object.keys(mappings).length }));\n`);

// Independent, deliberately narrow grammar: only the sample command, not a replacement for commands.json.
const manual = { type: "root", children: { scoreboard: { type: "literal", children: { players: { type: "literal", children: { set: { type: "literal", children: { target: { type: "argument", parser: "brigadier:string", properties: { type: "word" }, children: { objective: { type: "argument", parser: "brigadier:string", properties: { type: "word" }, children: { score: { type: "argument", parser: "brigadier:integer", executable: true } } } } } } } } } } } } };
const alternative = `export const grammarText = ${JSON.stringify(JSON.stringify(manual))};\nexport const mappingsText = ${JSON.stringify(JSON.stringify({ blocks: { "minecraft:stone": "minecraft:stone" } }))};\n`;
writeFileSync(new URL("../../servers/runtime-load-alternative-data.js", import.meta.url), alternative);
// Equivalent compact serialization: no commands.json file, but still derived data.
const compact = JSON.stringify(JSON.parse(grammar));
writeFileSync(new URL("../../servers/runtime-load-compact-data.js", import.meta.url), `export const grammarText = ${JSON.stringify(compact)};\nexport const mappingsText = ${JSON.stringify(mappings)};\n`);
