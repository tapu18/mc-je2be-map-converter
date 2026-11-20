import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect, it } from "vitest";
import { BedrockServer, JavaServer, jsonLines, paths, waitBedrockTicks, waitForLog, writeStructure } from "@je2be/bridge";
import { buildMcstructure, commandBlock, type ObjectiveScores, type StructureBlock } from "@je2be/core";

const here = dirname(fileURLToPath(import.meta.url));
const pack = join(here, "pack");
const y = -50;
const samplesPerPhase = 8;
const stand = "minecraft:armor_stand";
const names = ["place_seen", "summon_seen", "ok_seen", "fail_seen", "mixed_seen", "shared"] as const;
const tickScores = ["cb_value", "fn_value", "cb_count", "fn_count", "armed", "boot"];
type Edition = "java" | "bedrock";
type Pos = [number, number, number];
type Chain = { commands: string[]; conditional?: boolean; comparator?: boolean };
type Sample = { event: "cb" | "fn"; tick: number; seen: number; wrote: number };
type Trace = { event: string; tick: number; [key: string]: unknown };

const config = JSON.parse(readFileSync(join(here, "../../tools/servers.json"), "utf8"));
const results: Record<string, unknown> = {
  versions: { java: config.java.version, bedrock: config.bedrock.version },
};
let java: JavaServer | undefined;
let bds: BedrockServer | undefined;

afterEach(async () => {
  await java?.stop();
  await bds?.stop();
  java = undefined;
  bds = undefined;
});
afterAll(() => {
  writeFileSync(join(paths.servers, "results.runtime-queue.json"), JSON.stringify(results, null, 2) + "\n");
});

const set = (name: string, value: number) => `scoreboard players set ${name} rt ${value}`;

function chains(edition: Edition, runtime: boolean): Chain[] {
  const z = runtime ? 14 : 18;
  const radius = edition === "java" ? "distance=..2" : "r=2";
  const selector = `@e[type=${stand},x=4.5,y=${y},z=${z + 0.5},${radius}]`;
  const probe = (label: string) => `je2be:queue_probe ${label}`;
  return [
    { commands: runtime ? [probe("place")] : [
      `setblock 0 ${y} ${z} minecraft:stone`,
      `execute if block 0 ${y} ${z} minecraft:stone run ${set("place_seen", 1)}`,
    ] },
    { commands: runtime ? [probe("summon")] : [
      `summon ${stand} 4.5 ${y} ${z + 0.5}`,
      `execute as ${selector} run scoreboard players add summon_seen rt 1`,
    ] },
    { commands: [runtime ? probe("ok") : "tag @e[tag=probe_target] add probe_ok", set("ok_seen", 1)],
      conditional: true, comparator: true },
    { commands: [runtime ? probe("fail") : "tag @e[tag=probe_missing] add probe_fail", set("fail_seen", 1)],
      conditional: true, comparator: true },
    { commands: [
      set("shared", 1),
      runtime ? probe("mixed") : set("shared", 2),
      "scoreboard players operation mixed_seen rt = shared rt",
      "scoreboard players add shared rt 10",
    ] },
  ];
}

const comparator = {
  "minecraft:cardinal_direction": "south", direction: 0, output_lit_bit: false, output_subtract_bit: false,
};

function structure(runtime: boolean): Uint8Array {
  const blocks: StructureBlock[] = [];
  chains("bedrock", runtime).forEach(({ commands, comparator: hasComparator, conditional }, i) => {
    const x = i * 4;
    commands.forEach((command, j) => blocks.push(commandBlock({
      pos: [x, 0, j + 1], kind: j ? "chain" : "impulse", command, facing: 3,
      alwaysActive: j > 0, conditional: !!conditional && j > 0,
    })));
    if (hasComparator) blocks.push({ pos: [x, 0, 0], name: "minecraft:unpowered_comparator", states: comparator });
  });
  return buildMcstructure({ size: [17, 1, 5], blocks, fillAir: true });
}

function scoresOf(scores: ObjectiveScores[]) {
  const values = Object.fromEntries(scores.find(({ objective }) => objective === "rt")!.scores.map(
    ({ participant, score }) => [participant, score],
  ));
  return Object.fromEntries(names.map((name) => [name, values[name]]));
}

function entitiesAt(entities: { type: string; pos: number[]; tags: string[] }[], z: number) {
  return {
    spawned: entities.filter((e) => e.type === stand && Math.hypot(e.pos[0]! - 4.5, e.pos[1]! - y, e.pos[2]! - z - 0.5) < 2).length,
    tagged: entities.filter((e) => e.tags.includes("probe_target") && e.tags.includes("probe_ok")).length,
    unexpectedlyTagged: entities.filter((e) => e.tags.includes("probe_fail")).length,
  };
}

const normalize = <T extends { tick: number }>(samples: T[]): T[] => {
  const first = Math.min(...samples.map(({ tick }) => tick));
  return samples.map((sample) => ({ ...sample, tick: sample.tick - first }));
};

function assertClock(clock: Sample[]): void {
  expect(clock).toHaveLength(2 * samplesPerPhase);
  expect(clock[0]).toEqual({ event: "fn", tick: 0, seen: 0, wrote: 1 });
  for (const event of ["cb", "fn"] as const) {
    const samples = clock.filter((sample) => sample.event === event);
    expect(samples.map(({ wrote }) => wrote)).toEqual(Array.from({ length: samplesPerPhase }, (_, i) => i + 1));
    expect(samples.map(({ tick }) => tick - samples[0]!.tick)).toEqual(Array.from({ length: samplesPerPhase }, (_, i) => i));
  }
  // ゲーム時計が同値のイベントも、関数が追記した順、またはコンソールに出た順で読む。
  const lastWrite = { cb: 0, fn: 0 };
  for (const sample of clock) {
    const other = sample.event === "cb" ? "fn" : "cb";
    expect(sample.seen, JSON.stringify(sample)).toBe(lastWrite[other]);
    lastWrite[sample.event] = sample.wrote;
  }
  const paired = clock.filter((sample, i) => {
    const next = clock[i + 1];
    return sample.event === "cb" && next?.event === "fn" && next.tick === sample.tick;
  });
  expect(paired.length).toBeGreaterThanOrEqual(3);
}

const nativeExpected = {
  scores: { place_seen: 1, summon_seen: 1, ok_seen: 1, fail_seen: 0, mixed_seen: 2, shared: 12 },
  comparators: [true, false],
  placed: "minecraft:stone",
  entities: { spawned: 1, tagged: 1, unexpectedlyTagged: 0 },
};

it("records native Java chains and the first invocations of each phase at server startup", async () => {
  let server = java = await JavaServer.start({ datapacks: [join(here, "datapack/runtime_queue")] });
  const exec = async (command: string, feedback: RegExp) => {
    expect(await server.exec(command), command).toMatch(feedback);
  };
  await exec("scoreboard objectives add rt dummy", /Created new objective/);
  for (const name of [...names, ...tickScores]) await exec(set(name, 0), /Set/);
  await exec(`fill 0 ${y - 1} 0 20 ${y - 1} 24 stone`, /Successfully filled/);
  await exec(`summon ${stand} 20.5 ${y} 22.5 {Tags:["probe_target"]}`, /Summoned/);
  for (const [i, chain] of chains("java", false).entries()) {
    const x = i * 4;
    for (const [j, command] of chain.commands.entries()) {
      const kind = j ? "chain_command_block" : "command_block";
      const conditional = !!chain.conditional && j > 0;
      await exec(
        `setblock ${x} ${y} ${7 + j} ${kind}[facing=south,conditional=${conditional}]{Command:${JSON.stringify(command)},auto:${j ? 1 : 0}b}`,
        /Changed the block/,
      );
    }
    if (chain.comparator) await exec(`setblock ${x} ${y} 6 comparator[facing=south]`, /Changed the block/);
  }
  await exec(`fill 0 ${y + 1} 7 16 ${y + 1} 7 redstone_block`, /Successfully filled/);
  await expect.poll(() => server.exec("scoreboard players get shared rt")).toMatch(/has 12/);
  await expect.poll(() => server.exec(`execute if block 8 ${y} 6 comparator[powered=true]`)).toMatch(/Test passed/);

  const scores: Record<string, number> = {};
  for (const name of names) {
    const reply = await server.exec(`scoreboard players get ${name} rt`);
    const match = /has (-?\d+)/.exec(reply);
    expect(match, reply).not.toBeNull();
    scores[name] = Number(match![1]);
  }
  const dump = await server.dump({ entities: true, blocks: { from: [0, y, 6], to: [16, y, 18] } });
  const at = (x: number, z: number) => dump.blocks!.find(({ pos }) => pos[0] === x && pos[2] === z)!;
  results.javaChains = {
    scores,
    comparators: [8, 12].map((x) => at(x, 6).states.powered === "true"),
    successCounts: [8, 12].map((x) => (at(x, 7).nbt as { SuccessCount: number }).SuccessCount),
    placed: at(0, 18).type,
    entities: entitiesAt(dump.entities!, 18),
  };
  expect(results.javaChains).toEqual({ ...nativeExpected, successCounts: [1, 0] });

  const repeat = `execute if score boot rt matches 1 if score cb_count rt matches ..${samplesPerPhase - 1} run function probe:block_sample`;
  await exec(`setblock 0 ${y} 12 repeating_command_block[facing=south]{Command:${JSON.stringify(repeat)},auto:1b}`, /Changed the block/);
  await exec(set("armed", 1), /Set/);
  await exec("scoreboard players get cb_count rt", /has 0/);
  await exec("scoreboard players get fn_count rt", /has 0/);
  server = java = await server.restart();
  for (const name of ["cb_count", "fn_count"]) {
    await expect.poll(() => server.exec(`scoreboard players get ${name} rt`), { timeout: 15_000 })
      .toMatch(new RegExp(`has ${samplesPerPhase}\\b`));
  }
  const measured = (await server.dump({ storage: true })).storage!["probe:trace"] as { events: Sample[] };
  const clock = normalize(measured.events);
  results.javaStartup = clock;
  assertClock(clock);
});

it("compares native Bedrock and deferred chains and observes both phases from startup", async () => {
  writeStructure(pack, "native", structure(false));
  writeStructure(pack, "runtime", structure(true));
  writeStructure(pack, "clock", buildMcstructure({ size: [1, 1, 1], blocks: [
    commandBlock({ pos: [0, 0, 0], kind: "repeat", facing: 3, alwaysActive: true, command: "je2be:queue_probe tick" }),
  ] }));
  let server = bds = await BedrockServer.start({ behaviorPacks: [pack] });
  const exec = async (command: string) => {
    const response = await server.exec(command);
    expect(response.result?.successCount, `${command}: ${JSON.stringify(response)}`).toBeGreaterThan(0);
  };
  await exec("scoreboard objectives add rt dummy");
  await exec(`fill 0 ${y - 1} 0 20 ${y - 1} 24 stone`);
  await exec(`summon ${stand} 20.5 ${y} 22.5`);
  await exec(`tag @e[type=${stand},x=20.5,y=${y},z=22.5,r=2] add probe_target`);
  for (const runtime of [false, true]) {
    const name = runtime ? "runtime" : "native";
    const z = runtime ? 1 : 6;
    const targetZ = runtime ? 14 : 18;
    for (const score of names) await exec(set(score, 0));
    await exec(`structure load je2be:${name} 0 ${y} ${z}`);
    await exec(`fill 0 ${y + 1} ${z + 1} 16 ${y + 1} ${z + 1} redstone_block`);
    await waitBedrockTicks(server, 10);
    const { result: scores } = await server.request<ObjectiveScores[]>("scores");
    const { result: entities } = await server.request<{ type: string; pos: Pos; tags: string[] }[]>("entities");
    const { result: blocks } = await server.request<{ pos: Pos; type: string; states?: Record<string, unknown> }[]>("blocks", {
      from: [0, y, z], to: [16, y, targetZ],
    });
    const at = (x: number, z: number) => blocks!.find(({ pos }) => pos[0] === x && pos[2] === z)!;
    const observed = {
      scores: scoresOf(scores!),
      comparators: [8, 12].map((x) => at(x, z).states?.output_lit_bit),
      placed: at(0, targetZ).type,
      entities: entitiesAt(entities!, targetZ),
    };
    results[runtime ? "bedrockRuntime" : "bedrockNative"] = observed;
    expect(observed).toEqual(runtime ? {
      ...nativeExpected,
      scores: { ...nativeExpected.scores, fail_seen: 1, mixed_seen: 1, shared: 2 },
      comparators: [true, true],
    } : nativeExpected);
    if (!runtime) await exec("tag @e[tag=probe_target] remove probe_ok");
  }

  const trace = normalize(jsonLines<Trace>(server.log, "RUNTIME_QUEUE"));
  results.bedrockHandlerAndDrain = trace;
  expect(trace).toHaveLength(8);
  const place = trace.find(({ event }) => event === "place");
  const summon = trace.find(({ event }) => event === "summon");
  expect(place).toMatchObject({ committed: "minecraft:air", overlay: "minecraft:stone" });
  expect(summon).toMatchObject({ committed: 0, overlay: 1 });
  for (const [label, count] of [["ok", 1], ["fail", 0]] as const) {
    const assumed = trace.find((e) => e.event === "assumed" && e.label === label);
    const delegated = trace.find((e) => e.event === "delegated" && e.label === label);
    expect(assumed).toMatchObject({ success: true });
    expect(delegated).toMatchObject({ successCount: count, tick: assumed?.tick });
    expect(trace.indexOf(delegated!)).toBeGreaterThan(trace.indexOf(assumed!));
  }
  const mixed = trace.find(({ event }) => event === "mixed");
  expect(mixed).toMatchObject({ committed: 1 });
  expect(trace.find(({ event }) => event === "mixed_drain")).toMatchObject({ before: 11, wrote: 2, tick: mixed?.tick });

  for (const score of ["cb_value", "fn_value", "armed"]) await exec(set(score, 0));
  await exec(`structure load je2be:clock 0 ${y} 12`);
  await exec(set("armed", 1));
  await waitBedrockTicks(server, 2);
  expect(jsonLines<Trace>(server.log, "RUNTIME_QUEUE")).toHaveLength(trace.length);
  server = bds = await server.restart();
  for (const event of ["cb", "fn"]) {
    const last = new RegExp(`"event":"${event}".*"wrote":${samplesPerPhase}\\b`);
    await waitForLog(server.log, (line) => line.includes("RUNTIME_QUEUE") && last.test(line), 15_000);
  }
  const clock = normalize(jsonLines<Sample>(server.log, "RUNTIME_QUEUE"));
  results.bedrockStartup = clock;
  assertClock(clock);
  const { result: scores } = await server.request<ObjectiveScores[]>("scores");
  const values = scores!.find(({ objective }) => objective === "rt")!.scores;
  for (const name of ["cb_value", "fn_value"]) {
    expect(values.find(({ participant }) => participant === name)?.score).toBe(samplesPerPhase);
  }
});
