import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CommandParser, executeCommand, nbtToPlain, RuntimeState, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { paths } from "./paths.ts";

it("executes storage-paths actions through CommandIR and matches Java's recorded state", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const scenario = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/storage-paths.json", import.meta.url), "utf8"));
  const expected = JSON.parse(readFileSync(new URL("../../../scenarios/datapack/storage-paths.java.json", import.meta.url), "utf8"));
  const state = new RuntimeState();
  const lines: string[] = [...scenario.setup, ...scenario.actions.map((a: {run: string}) => a.run)];
  for (const line of lines) {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(`${line}: ${parsed.error.message}`);
    expect(executeCommand(state, toCommandIR(line, parsed.nodes)), line).toMatchObject({success: true});
  }
  expect(nbtToPlain(state.storage.get("m2:probe"))).toEqual(expected.state.storage["m2:probe"]);
});

it("rejects unsupported execute chains before modifying storage", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const state = new RuntimeState();
  const source = "execute if data storage m2:probe absent if data storage m2:probe other run data modify storage m2:probe x set value 1";
  const parsed = parser.parse(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(executeCommand(state, toCommandIR(source, parsed.nodes))).toEqual({success: false, error: "unsupported execute chain"});
  expect(state.storage.values.size).toBe(0);
});

it("merges compound storage values recursively", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const state = new RuntimeState();
  const run = (line: string) => {
    const parsed = parser.parse(line);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return executeCommand(state, toCommandIR(line, parsed.nodes));
  };
  expect(run("data merge storage test:paths {a:{x:1,y:2}}")).toMatchObject({success: true});
  expect(run("data merge storage test:paths {a:{x:3}}")).toMatchObject({success: true});
  expect(nbtToPlain(state.storage.get("test:paths"))).toEqual({a: {x: 3, y: 2}});
  expect(run("data merge storage test:paths {a:{x:3}}")).toMatchObject({success: false});
  expect(run("data modify storage test:paths b.list append value 3")).toMatchObject({success: true});
  expect(run("data modify storage test:paths b.object merge value {x:1}")).toMatchObject({success: true});
  expect(nbtToPlain(state.storage.get("test:paths"))).toEqual({a: {x: 3, y: 2}, b: {list: [3], object: {x: 1}}});
});
