// 実機テスト用：生成した je2be_init パックに、ランタイムの動的プロパティを読み書きするプローブを足す。
// 動的プロパティはパックごとに分かれるため、検証パックからは読めない。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BedrockServer } from "./bedrock.ts";

const PROBE = `import "./main.js";
import { world, system } from "@minecraft/server";
system.afterEvents.scriptEventReceive.subscribe(event => {
  if (event.id !== "je2be:probe") return;
  const req = JSON.parse(event.message);
  const reply = body => console.warn("JE2BE_PROBE " + JSON.stringify({id: req.id, ...body}));
  try {
    let result;
    if (req.op === "get") result = req.keys.map(key => world.getDynamicProperty(key) ?? null);
    else if (req.op === "set") { for (const [key, value] of req.entries) world.setDynamicProperty(key, value ?? undefined); }
    else if (req.op === "put") world.setDynamicProperty(req.key, req.char.repeat(req.length));
    else if (req.op === "keys") result = world.getDynamicPropertyIds().filter(key => key.startsWith(req.prefix)).sort();
    else if (req.op === "bytes") result = world.getDynamicPropertyTotalByteCount();
    else if (req.op === "fill") {
      const value = req.char.repeat(req.length);
      for (let i = req.from; i < req.to; i++) world.setDynamicProperty("probe:fill:" + i, value);
      result = world.getDynamicPropertyTotalByteCount();
    } else if (req.op === "check") {
      let bad = 0;
      for (let i = req.from; i < req.to; i++) if (world.getDynamicProperty("probe:fill:" + i)?.length !== req.length) bad++;
      result = bad;
    } else throw Error("unknown op " + req.op);
    reply({ok: true, result});
  } catch (error) { reply({ok: false, error: String(error)}); }
});
`;

/** Switch the pack entry to a probe that imports the runtime unchanged. */
export function addRuntimeProbe(packDir: string): void {
  writeFileSync(join(packDir, "scripts", "probe.js"), PROBE);
  const file = join(packDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {modules: {entry: string}[]};
  manifest.modules[0]!.entry = "scripts/probe.js";
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}

let next = 1;
export async function probe<T>(bds: BedrockServer, op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const id = next++;
  bds.console(`scriptevent je2be:probe ${JSON.stringify({id, op, ...args})}`);
  const line = await bds.waitForLog(l => l.includes(`JE2BE_PROBE {"id":${id},`), timeoutMs, `probe ${op}`);
  const res = JSON.parse(line.slice(line.indexOf("JE2BE_PROBE ") + 12)) as {ok: boolean; result?: T; error?: string};
  if (!res.ok) throw Error(`probe ${op}: ${res.error}`);
  return res.result as T;
}
