import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  CommandParser, compileMacroTemplate, deserializeCommandIR, executeCommand, nbtToPlain, normalizeCommandIR, parseSnbt,
  RuntimeState, serializeCommandIR, toCommandIR, type CommandTreeNode, type ExecutionHost, type RuntimeEntity,
} from "@je2be/core";
import { paths } from "../../bridge/src/paths.ts";
import { loadScenarios, readGolden } from "../../bridge/src/scenario/load.ts";

const scenarios = loadScenarios();
const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});

it.each(["macro-arguments", "storage-macro"])("%s matches the Java golden states", id => {
  const scenario = scenarios.find(s => s.id === `datapack/${id}`)!;
  const golden = readGolden(scenario)!;
  const marker: RuntimeEntity = {
    id: "marker-1", type: "minecraft:marker", tags: ["macro_source"], position: [8, -60, 8],
    dimension: "minecraft:overworld", rotation: [0, 0], eyeHeight: 0,
  };
  const host: ExecutionHost = {
    entities: () => id === "macro-arguments" ? [marker] : [],
    readEntityNbt: entity => {
      if (entity !== marker.id) return;
      const tag = parseSnbt("{data:{value:42}}");
      if (tag.type === "compound") return tag;
    },
    readBlock: (dimension, position) => {
      if (dimension === marker.dimension && position.join(" ") === "9 -60 8") {
        return {kind: "block", id: "minecraft:chest", tag: false, states: {}, nbt: parseSnbt(`{CustomName:'"chest"'}`)};
      }
    },
  };
  const state = new RuntimeState(host);
  const parse = (source: string) => {
    const parsed = parser.parse(source);
    if (!parsed.ok) throw Error(parsed.error.message);
    const normalized = normalizeCommandIR(toCommandIR(source, parsed.nodes), golden.java);
    if (!normalized.ok) throw Error(normalized.reason);
    return normalized.ir;
  };
  for (const [name, lines] of Object.entries(scenario.datapack!.functions)) {
    state.functions.set(name, lines.map(line => {
      if (!line.startsWith("$")) return parse(line);
      const result = compileMacroTemplate(parser, line, golden.java);
      if (!result.ok) throw Error(`${line}: ${result.reason}`);
      const decoded = deserializeCommandIR(serializeCommandIR({grammarVersion: golden.java, textFormat: "snbt", ir: result.ir}));
      if (!decoded.ok) throw Error(decoded.diagnostic);
      return decoded.document.ir;
    }));
  }
  const run = (line: string) => executeCommand(state, parse(line));
  for (const line of scenario.setup) {
    // The marker and chest setup is supplied by the fake host's world data above.
    if (id === "macro-arguments" && /^(summon marker|setblock|data merge block) /.test(line)) continue;
    expect(run(line), line).toMatchObject({success: true});
  }
  for (const action of scenario.actions) {
    if (!("run" in action)) throw Error("unexpected action");
    expect(run(action.run), action.run).toMatchObject({success: !action.run.includes("{other:1}")});
  }
  const actual = {
    ...(scenario.observe.scores && {scores: Object.fromEntries(scenario.observe.scores.map(key =>
      [key, Object.fromEntries(state.scores.objectives.get(key) ?? [])]))}),
    storage: Object.fromEntries(scenario.observe.storage!.map(key => [key, nbtToPlain(state.storage.get(key))])),
  };
  expect(actual).toEqual(golden.state);
  for (const version of ["1.20.6", "1.21.4", "1.21.11", "26.2"]) {
    expect(actual, `Java ${version} golden state`).toEqual(readGolden(scenario, undefined, version)!.state);
  }
});

it("diagnoses holes in literals, across argument boundaries and in mapped IDs", () => {
  expect(compileMacroTemplate(parser, "$execute positioned $(where) run say hi", "26.3"))
    .toMatchObject({ok: false, reason: expect.stringContaining("command shape")});
  expect(compileMacroTemplate(parser, "$scoreboard players set $(holder_and_objective) 1", "26.3"))
    .toMatchObject({ok: false, reason: expect.stringContaining("argument boundary")});
  expect(compileMacroTemplate(parser, "$setblock ~ ~ ~ $(block)", "26.3"))
    .toMatchObject({ok: false, reason: expect.stringContaining("ID mapping")});
});

it("rejects missing keys and invalid values before any function line runs", () => {
  const parse = (source: string) => {
    const result = parser.parse(source);
    if (!result.ok) throw Error(result.error.message);
    return toCommandIR(source, result.nodes);
  };
  const state = new RuntimeState();
  const template = compileMacroTemplate(parser, "$scoreboard players set #$(holder) demo $(score)", "26.3");
  if (!template.ok) throw Error(template.reason);
  state.functions.set("demo:macro", [parse("scoreboard objectives add demo dummy"), template.ir]);
  const run = (command: string) => executeCommand(state, parse(command));
  expect(run("function demo:macro")).toEqual({success: false, error: "missing macro argument 'holder'"});
  expect(run('function demo:macro {holder:"a b",score:3}')).toMatchObject({success: false});
  expect(run('function demo:macro {holder:"a",score:2147483648L}')).toMatchObject({success: false});
  expect(state.scores.objectives.has("demo")).toBe(false);
  expect(run('function demo:macro {holder:"a",score:3}')).toMatchObject({success: true});
  expect(state.scores.get("#a", "demo")).toBe(3);
});
