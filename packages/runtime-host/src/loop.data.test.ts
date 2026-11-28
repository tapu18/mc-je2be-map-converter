import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { CommandParser, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { paths } from "../../bridge/src/paths.ts";

/** A BE scoreboard holding fake players only, which is all these tests write. */
class Objective {
  readonly scores = new Map<string, number>();
  constructor(readonly id: string) {}
  getParticipants() { return [...this.scores.keys()].map(displayName => ({type: "FakePlayer", displayName})); }
  getScore(participant: string | {displayName: string}) { return this.scores.get(typeof participant === "string" ? participant : participant.displayName); }
  hasParticipant(name: string) { return this.scores.has(name); }
  removeParticipant(name: string) { return this.scores.delete(name); }
  setScore(name: string, value: number) {
    if (fake.failWrites) throw Error("setScore failed");
    this.scores.set(name, value);
  }
}
const fake = vi.hoisted(() => ({
  objectives: new Map<string, Objective>(),
  commands: [] as string[],
  failWrites: false,
}));
vi.mock("@minecraft/server", () => ({
  ScoreboardIdentityType: {FakePlayer: "FakePlayer", Entity: "Entity", Player: "Player"},
  GameMode: {Survival: "Survival", Creative: "Creative", Adventure: "Adventure", Spectator: "Spectator"},
  world: {
    scoreboard: {
      getObjective: (id: string) => fake.objectives.get(id),
      addObjective: (id: string) => { const objective = new Objective(id); fake.objectives.set(id, objective); return objective; },
      removeObjective: (id: string) => fake.objectives.delete(id),
    },
    getPlayers: () => [],
    getEntity: () => undefined,
    getDimension: () => ({runCommand: (command: string) => { fake.commands.push(command); return {successCount: 1}; }}),
  },
}));
import { RuntimeState } from "../../core/src/runtime/command.ts";
import { RuntimeSession } from "./host.ts";
import { runFunctionTag, startTicking, type Scheduler } from "./loop.ts";

const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
const parse = (source: string) => {
  const parsed = parser.parse(source);
  if (!parsed.ok) throw Error(`${source}: ${parsed.error.message}`);
  return toCommandIR(source, parsed.nodes);
};
const undelegated = "particle minecraft:flame ~ ~ ~";
const stored = `execute store success score #stored clock run ${undelegated}`;

/** Run load, then start the tick loop on a scheduler the test advances by hand. */
function start(functions: Record<string, string[]>, options: {failUndelegated?: boolean} = {failUndelegated: true}) {
  const state = new RuntimeState();
  for (const [id, lines] of Object.entries(functions)) state.functions.set(id, lines.map(parse));
  for (const tag of ["load", "tick"]) if (state.functions.has(`test:${tag}`)) state.functionTags.set(`minecraft:${tag}`, [`test:${tag}`]);
  state.scores.addObjective("clock");
  fake.objectives.set("clock", new Objective("clock"));
  const warnings: string[] = [];
  const warn = (message: string) => { warnings.push(message); };
  const runtime = new RuntimeSession(state, source => source === "say delegated" ? {command: source, completion: "synchronous"} : undefined, {...options, warn});
  let callback: (() => void) | undefined;
  const scheduler: Scheduler = {runInterval: run => { callback = run; return 7; }, clearRun: vi.fn(() => { callback = undefined; })};
  runFunctionTag(runtime, "minecraft:load");
  startTicking(runtime, () => {}, scheduler, warn);
  const tick = (count: number) => { for (let i = 0; i < count; i++) callback?.(); };
  const score = (holder: string) => fake.objectives.get("clock")!.scores.get(holder);
  return {runtime, scheduler, warnings, tick, score, running: () => callback !== undefined};
}

beforeEach(() => {
  fake.objectives.clear();
  fake.commands.length = 0;
  fake.failWrites = false;
});

it("fails an undelegated line like a Java command and keeps running later lines every tick, warning once per line", () => {
  const {warnings, tick, score, running} = start({"test:tick": [
    "scoreboard players add #before clock 1",
    undelegated,
    "say delegated",
    "scoreboard players set #stored clock 5",
    stored,
    "scoreboard players add #after clock 1",
  ]});
  tick(3);
  expect(running()).toBe(true);
  expect(score("#before")).toBe(3);
  expect(score("#after")).toBe(3);
  // `execute store success` sees the failure.
  expect(score("#stored")).toBe(0);
  expect(fake.commands.filter(command => command.endsWith("run say delegated"))).toHaveLength(3);
  expect(warnings).toEqual([
    `[je2be] function test:tick command 2 fails without a BE command: ${undelegated}`,
    `[je2be] function test:tick command 5 fails without a BE command: ${stored}`,
  ]);
});

it("names the innermost function line when the undelegated command is in a called function", () => {
  const {warnings, tick, score} = start({
    "test:tick": ["function test:inner", "scoreboard players add #after clock 1"],
    "test:inner": ["scoreboard players add #inner clock 1", undelegated],
  });
  tick(2);
  expect(score("#after")).toBe(2);
  expect(warnings).toEqual([`[je2be] function test:inner command 2 fails without a BE command: ${undelegated}`]);
});

it("starts ticking when the load function has an undelegated line", () => {
  const {warnings, tick, score, running} = start({
    "test:load": [undelegated, "scoreboard players set #loaded clock 1"],
    "test:tick": ["scoreboard players add #tick clock 1"],
  });
  tick(2);
  expect(running()).toBe(true);
  expect(score("#loaded")).toBe(1);
  expect(score("#tick")).toBe(2);
  expect(warnings).toEqual([`[je2be] function test:load command 1 fails without a BE command: ${undelegated}`]);
});

it("still stops on an undelegated line when the session does not fail undelegated lines", () => {
  const {runtime, scheduler, warnings, tick, score, running} = start({"test:tick": [undelegated, "scoreboard players add #after clock 1"]}, {});
  tick(2);
  expect(running()).toBe(false);
  expect(runtime.isConsistent).toBe(false);
  expect(scheduler.clearRun).toHaveBeenCalledWith(7);
  expect(score("#after")).toBeUndefined();
  expect(warnings).toEqual([expect.stringMatching(/^\[je2be\] tick stopped: .*unsupported command/)]);
});

it("still stops the tick loop when a score projection fails", () => {
  const {runtime, scheduler, warnings, tick, running} = start({"test:tick": [undelegated, "scoreboard players add #after clock 1"]});
  fake.failWrites = true;
  tick(2);
  expect(running()).toBe(false);
  expect(runtime.isConsistent).toBe(false);
  expect(scheduler.clearRun).toHaveBeenCalledWith(7);
  expect(warnings.at(-1)).toMatch(/^\[je2be\] tick stopped: .*setScore failed/);
});

it("still stops the tick loop when a budget is exceeded", () => {
  const {runtime, scheduler, warnings, tick, running} = start({
    "test:tick": [undelegated, "function test:loop"],
    "test:loop": ["function test:loop"],
  });
  tick(2);
  expect(running()).toBe(false);
  expect(runtime.isConsistent).toBe(false);
  expect(scheduler.clearRun).toHaveBeenCalledWith(7);
  expect(warnings.at(-1)).toMatch(/^\[je2be\] tick stopped: .*depth budget exceeded/);
});
