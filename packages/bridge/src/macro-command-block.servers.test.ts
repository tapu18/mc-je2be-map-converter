import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { JavaServer } from "./java.ts";

it("checks macro calls and a dollar-prefixed command in command blocks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "je2be-macro-"));
  const pack = join(dir, "probe");
  mkdirSync(join(pack, "data", "probe", "function"), { recursive: true });
  writeFileSync(join(pack, "pack.mcmeta"), JSON.stringify({ pack: { description: "probe", pack_format: 121, min_format: 121, max_format: 121 } }));
  writeFileSync(join(pack, "data", "probe", "function", "macro.mcfunction"), "$scoreboard players set #$(name) probe 1\n");
  let java: JavaServer | undefined;
  try {
    java = await JavaServer.start({ datapacks: [pack] });
    await java.exec("scoreboard objectives add probe dummy");
    await java.exec('data modify storage probe:args args set value {name:"storage"}');
    const commands = [
      '$scoreboard players set #dollar probe 1',
      'function probe:macro {name:"inline"}',
      'function probe:macro with storage probe:args args',
    ];
    for (let i = 0; i < commands.length; i++) {
      const command = JSON.stringify(commands[i]);
      expect(await java.exec(`setblock ${i + 1} -50 1 command_block{Command:${command},auto:1b}`)).toContain("Changed");
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(await java.exec("scoreboard players get #inline probe")).toMatch(/1/);
    expect(await java.exec("scoreboard players get #storage probe")).toMatch(/1/);
    expect(await java.exec("scoreboard players get #dollar probe")).toMatch(/none is set/i);
    expect(await java.exec('data get block 1 -50 1 Command')).toContain('$scoreboard players set #dollar probe 1');
  } finally {
    await java?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
