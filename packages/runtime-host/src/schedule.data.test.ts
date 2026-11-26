import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  advanceScheduledTick, CommandParser, executeCommand, nbtToPlain, RuntimeState, toCommandIR,
  type CommandTreeNode, type ExecutionHost,
} from "@je2be/core";
import { paths } from "../../bridge/src/paths.ts";
import { loadScenarios, readGolden } from "../../bridge/src/scenario/load.ts";
import type { NormalizedState } from "../../bridge/src/scenario/types.ts";
import { commitState, restoreState, type Properties } from "./persistence.ts";

const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
const scenarios = loadScenarios();

function parse(source: string) {
  const parsed = parser.parse(source);
  if (!parsed.ok) throw Error(`${source}: ${parsed.error.message}`);
  return toCommandIR(source, parsed.nodes);
}

it.each(["schedule", "schedule-units", "schedule-day", "schedule-restart"])("%s matches the Java golden data", id => {
  const scenario = scenarios.find(s => s.id === `datapack/${id}`)!;
  const values = new Map<string, string>();
  const properties: Properties = {
    get: key => values.get(key),
    set(key, value) {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
  const host: ExecutionHost = {
    entities: () => [],
    readBlock: () => undefined,
    writeBlock: () => { throw Error("unexpected block write"); },
    runNative(command) {
      if (command.name === "time" && command.nodes.map(node => node.name).join(" ") === "query gametime") {
        return {success: true, result: state.schedule.tick % 2_147_483_647};
      }
    },
  };
  let state = new RuntimeState(host);
  const loadDatapack = () => {
    for (const [name, lines] of Object.entries(scenario.datapack!.functions)) state.functions.set(name, lines.map(parse));
    for (const [name, tag] of Object.entries(scenario.datapack!.functionTags ?? {})) {
      state.functionTags.set(name, tag.values.map(value => typeof value === "string" ? value : value.id));
    }
  };
  const run = (line: string) => expect(executeCommand(state, parse(line)), line).toMatchObject({success: true});

  for (const line of scenario.setup) run(line);
  loadDatapack();
  for (const action of scenario.actions) {
    if ("run" in action) run(action.run);
    else if ("ticks" in action) {
      for (let tick = 0; tick < action.ticks; tick++) {
        for (const {id, result} of advanceScheduledTick(state)) expect(result, id).toMatchObject({success: true});
      }
    } else if ("restart" in action) {
      commitState(properties, state);
      state = restoreState(properties, host)!;
      loadDatapack();
    } else throw Error("unexpected command block action");
  }

  const actual: NormalizedState = {};
  const {observe} = scenario;
  if (observe.scores) actual.scores = Object.fromEntries(observe.scores.map(key => [key, Object.fromEntries(state.scores.objectives.get(key) ?? [])]));
  if (observe.storage) actual.storage = Object.fromEntries(observe.storage.map(key => [key, nbtToPlain(state.storage.get(key))]));
  expect(actual).toEqual(readGolden(scenario)!.state);
});

it("de-duplicates append, replaces by default, and lets a callback clear a later callback on the same tick", () => {
  const state = new RuntimeState();
  state.functions.set("test:a", []);
  state.functions.set("test:b", []);
  state.functions.set("test:cancel", [parse("schedule clear test:b")]);
  state.functionTags.set("test:a", ["test:b"]);
  const run = (line: string) => executeCommand(state, parse(line));

  expect(run("schedule function test:a 1t append")).toEqual({success: true, result: 1});
  for (const line of [
    "schedule function test:cancel 2t append",
    "schedule function test:b 2t append",
    "schedule function #test:a 2t append",
    "schedule function test:a 2t",
    "schedule function test:a 2t append",
  ]) expect(run(line), line).toEqual({success: true, result: 2});
  expect(run("schedule function test:a 0t")).toMatchObject({success: false});
  expect(advanceScheduledTick(state)).toEqual([]);
  expect(advanceScheduledTick(state).map(({id}) => id)).toEqual(["test:cancel", "test:b", "test:a"]);
  expect(run("schedule clear test:b")).toMatchObject({success: false});
  expect(run("schedule function test:a 0.0249999999s")).toEqual({success: true, result: 3});
  expect(run("schedule function test:a 2147483648t")).toEqual({success: true, result: 2});
});
