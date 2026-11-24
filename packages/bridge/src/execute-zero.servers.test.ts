// #220: execute の失敗時の応答、メモリ上のスコア、保存データを別々に観測する。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { nbtToPlain, readNbt } from "@je2be/core";
import { expect, it } from "vitest";
import { JavaServer } from "./java.ts";
import { paths, repoRoot } from "./paths.ts";

const version = process.env.JE2BE_JAVA_VERSION;
if (version && !/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error("Invalid Java version");
const commands: Record<string, string> = {
  "#all_mismatch": "execute if blocks 24 70 20 25 70 20 32 70 20 all",
  "#masked_diff": "execute if blocks 24 70 20 25 70 20 32 70 20 masked",
  "#unloaded_if": "execute if loaded 1000000 0 1000000",
  "#wrong_dimension": "execute if dimension minecraft:the_nether",
};
const golden = join(repoRoot, `scenarios/datapack/execute-zero-observations.java${version ? `.${version}` : ""}.json`);

it("records execute zero responses before and after saving", async () => {
  let java = await JavaServer.start(version ? { runtime: { java: paths.java, serverDirectory: join(paths.servers, "grammars", version, "server") } } : {});
  try {
    await java.exec("tick freeze");
    await java.exec("scoreboard objectives add probe dummy");
    for (const c of ["setblock 24 70 20 stone", "setblock 25 70 20 dirt", "setblock 32 70 20 stone", "setblock 33 70 20 gold_block"]) await java.exec(c);
    const responses: Record<string, { command: string; getBeforeSave: string; getAfterSave?: string; getAfterRestart?: string }> = {};
    for (const [name, condition] of Object.entries(commands)) {
      await java.exec(`scoreboard players set ${name} probe -1`);
      const command = await java.exec(`execute store result score ${name} probe run ${condition}`);
      const getBeforeSave = await java.exec(`scoreboard players get ${name} probe`);
      responses[name] = { command, getBeforeSave };
    }
    const dump = await java.dump({ scores: true });
    const saved = Object.fromEntries((dump.scores?.find((s) => s.objective === "probe")?.scores ?? []).map((s) => [s.participant, s.score]));
    const modern = join(java.worldDirectory, "data", "minecraft", "scoreboard.dat");
    const file = existsSync(modern) ? modern : join(java.worldDirectory, "data", "scoreboard.dat");
    const raw = nbtToPlain(readNbt(gunzipSync(readFileSync(file)), "java").tag) as { data: { PlayerScores: { Name: string; Objective: string; Score?: number }[] } };
    const savedNbt = raw.data.PlayerScores.filter((row) => row.Objective === "probe").sort((a, b) => a.Name.localeCompare(b.Name));
    for (const name of Object.keys(commands)) responses[name]!.getAfterSave = await java.exec(`scoreboard players get ${name} probe`);
    java = await java.restart();
    for (const name of Object.keys(commands)) responses[name]!.getAfterRestart = await java.exec(`scoreboard players get ${name} probe`);
    const result = { java: version ?? JSON.parse(readFileSync(join(repoRoot, "tools/servers.json"), "utf8")).java.version, responses, saved, savedNbt };
    if (process.env.JE2BE_RECORD === "1") writeFileSync(golden, JSON.stringify(result, null, 2) + "\n");
    else expect(result).toEqual(JSON.parse(readFileSync(golden, "utf8")));
  } finally { await java.stop(); }
});
