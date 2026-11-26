import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JavaServer } from "./java.ts";
import { paths } from "./paths.ts";

// 調査用の 1.20.4 を明示的に生成した環境でのみ実行する。
const oldDir = join(paths.servers, "grammars/1.20.4/server");
it.skipIf(!existsSync(join(oldDir, "server.jar")))("observes a 1.20.4 world opened by the fixed Java server", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "je2be-upgrade-"));
  let old: JavaServer | undefined;
  let newer: JavaServer | undefined;
  const command = 'give @p minecraft:stone{display:{Name:\'{"text":"probe"}\'}}';
  try {
    old = await JavaServer.start({ runtime: { java: paths.java, serverDirectory: oldDir }, forceload: [0, 0, 15, 15] });
    expect(await old.exec(`setblock 1 -60 1 minecraft:command_block{Command:${JSON.stringify(command)}}`)).toMatch(/Changed the block/);
    expect(await old.exec('setblock 2 -60 1 minecraft:chest{Items:[{Slot:0b,id:"minecraft:stone",Count:1b,tag:{CustomModelData:123}}]}')).toMatch(/Changed the block/);
    expect(await old.exec('summon minecraft:armor_stand 3 -60 1 {Tags:["upgrade_probe"],NoGravity:1b,CustomName:\'{"text":"probe"}\'}')).toMatch(/Summoned/);
    const fn = join(old.worldDirectory, "datapacks/probe/data/probe/functions/test.mcfunction");
    mkdirSync(join(fn, ".."), { recursive: true });
    writeFileSync(fn, command + "\n");
    const world = old.worldDirectory;
    await old.stop(); old = undefined;
    cpSync(world, join(tmp, "world"), { recursive: true });
    newer = await JavaServer.start({ world: join(tmp, "world"), forceload: [0, 0, 15, 15] });
    const block = await newer.exec("data get block 1 -60 1 Command");
    const chest = await newer.exec("data get block 2 -60 1 Items");
    const entity = await newer.exec('data get entity @e[type=minecraft:armor_stand,tag=upgrade_probe,limit=1] CustomName');
    expect(block).toContain(command.replaceAll('"', '\\"'));
    expect(chest).toContain("minecraft:custom_model_data");
    expect(chest).toContain("123");
    expect(await newer.exec("execute if items block 2 -60 1 container.0 stone[custom_model_data={floats:[123f]}]")).toMatch(/Test passed/);
    expect(entity).toContain("probe");
    expect(readFileSync(join(newer.worldDirectory, "datapacks/probe/data/probe/functions/test.mcfunction"), "utf8")).toBe(command + "\n");
  } finally {
    await old?.stop(); await newer?.stop(); rmSync(tmp, { recursive: true, force: true });
  }
});
