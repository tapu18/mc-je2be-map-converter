import { join } from "node:path";
import { expect, it } from "vitest";
import { javaGrammarSources, readGzipNbt, setupJavaGrammar } from "@je2be/converter";
import { JavaServer } from "./java.ts";

it("compares saved time markers across Java 1.21.11 and 26.1", async () => {
  const values: bigint[][] = [];
  for (const version of ["1.21.11", "26.1"]) {
    const source = javaGrammarSources().find(s => s.version === version);
    if (!source) throw new Error(`Missing grammar ${version}`);
    const grammar = await setupJavaGrammar(source);
    const server = await JavaServer.start({ runtime: { java: grammar.java, serverDirectory: grammar.serverDirectory } });
    try {
      await server.exec("tick freeze");
      const ticks: bigint[] = [];
      for (const marker of ["day", "noon", "night", "midnight"]) {
        await server.exec(`time set ${marker}`);
        await server.exec("save-all flush");
        const file = version === "1.21.11" ? "level.dat" : "data/minecraft/world_clocks.dat";
        const tag = readGzipNbt(join(server.worldDirectory, file));
        const path = version === "1.21.11" ? ["Data", "DayTime"] : ["data", "minecraft:overworld", "total_ticks"];
        let value: unknown = tag;
        for (const key of path) {
          if (!value || typeof value !== "object" || !("type" in value) || value.type !== "compound" || !("value" in value) || !(value.value instanceof Map)) throw new Error(`Missing ${key}`);
          value = value.value.get(key);
        }
        if (!value || typeof value !== "object" || !("type" in value) || value.type !== "long" || !("value" in value) || typeof value.value !== "bigint") throw new Error("Missing time");
        ticks.push(value.value % 24000n);
      }
      values.push(ticks);
    } finally { await server.stop(); }
  }
  expect(values).toEqual([[1000n, 6000n, 13000n, 18000n], [1000n, 6000n, 13000n, 18000n]]);
}, 240_000);
