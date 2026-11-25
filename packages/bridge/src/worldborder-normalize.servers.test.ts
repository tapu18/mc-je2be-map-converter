import { expect, it } from "vitest";
import { javaGrammarSources, setupJavaGrammar } from "@je2be/converter";
import { JavaServer } from "./java.ts";

it("compares isolated worldborder time commands across 1.21.10 and 1.21.11", async () => {
  const outputs: string[][] = [];
  const extremeWarningTimes: string[] = [];
  for (const version of ["1.21.10", "1.21.11"]) {
    const source = javaGrammarSources().find(s => s.version === version);
    if (!source) throw new Error(`Missing grammar ${version}`);
    const grammar = await setupJavaGrammar(source);
    const server = await JavaServer.start({ runtime: { java: grammar.java, serverDirectory: grammar.serverDirectory } });
    try {
      const time = version === "1.21.10" ? "7" : "7s";
      const result: string[] = [];
      for (const command of [`worldborder add 100 ${time}`, `worldborder set 200 ${time}`, `worldborder warning time ${time}`]) {
        await server.exec("worldborder set 1000");
        result.push((await server.exec(command)).replace(/7\.00/g, "7"));
      }
      outputs.push(result);
      const extreme = version === "1.21.10" ? "2147483647" : "2147483647s";
      extremeWarningTimes.push(await server.exec(`worldborder warning time ${extreme}`));
    } finally { await server.stop(); }
  }
  expect(outputs[1]).toEqual(outputs[0]);
  expect(extremeWarningTimes[0]).toContain("2147483647");
  expect(extremeWarningTimes[1]).toContain("107374182.35");
}, 240_000);
