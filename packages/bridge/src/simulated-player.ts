import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMcstructure } from "@je2be/core";
import { BedrockServer } from "./bedrock.ts";
import { paths } from "./paths.ts";
import { createDataPack } from "./poc-kit.ts";

/**
 * GameTest の試験用プレイヤー（名前 `name`）を 8.5 -59 8.5 に置いた BDS で run を実行する。
 * プレイヤーを対象にするコマンド（playsound・tellraw・titleraw）の成功件数を観測するため（#90・#347）。
 */
export async function withSimulatedPlayer(
  name: string,
  run: (bds: BedrockServer) => Promise<void>,
  world?: string,
): Promise<void> {
  const pack = createDataPack({ empty: buildMcstructure({ size: [1, 2, 1], blocks: [] }) });
  let bds: BedrockServer | undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(paths.bridgePack, "manifest.json"), "utf8"));
    manifest.header.name = "je2be simulated player";
    manifest.header.uuid = randomUUID();
    manifest.modules[0].uuid = randomUUID();
    manifest.dependencies.push({ module_name: "@minecraft/server-gametest", version: "1.0.0-beta" });
    writeFileSync(join(pack, "manifest.json"), JSON.stringify(manifest));
    mkdirSync(join(pack, "scripts"));
    writeFileSync(join(pack, manifest.modules[0].entry), `
import { register } from "@minecraft/server-gametest";
register("je2be", "simulated_player", (test) => {
  test.spawnSimulatedPlayer({ x: 0, y: 0, z: 0 }, ${JSON.stringify(name)});
  console.log("JE2BE_SIMULATED_PLAYER_READY");
}).structureName("je2be:empty").maxTicks(5000);
`);
    bds = await BedrockServer.start({ behaviorPacks: [pack], ...(world ? { world, worldSettings: "preserve" } : {}) });
    const started = await bds.exec("gametest run je2be:simulated_player");
    if (!started.ok || started.result?.successCount !== 1) throw new Error(`gametest did not start: ${JSON.stringify(started)}`);
    await bds.waitForLog((line) => line.includes("JE2BE_SIMULATED_PLAYER_READY"), 10_000, "simulated player");
    const moved = await bds.exec(`tp ${name} 8.5 -59 8.5`);
    if (!moved.ok || moved.result?.successCount !== 1) throw new Error(`simulated player did not move: ${JSON.stringify(moved)}`);
    await run(bds);
  } finally {
    try {
      await bds?.stop();
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  }
}
