import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JavaServer, type JavaStartOptions } from "../java.ts";
import type { ScenarioDatapack } from "./types.ts";

const PACK = "je2be-scenario";
const READY = "je2be_scenario:reload_ready";

function resourcePath(root: string, id: string, directory: string, extension: string): string {
  const [, namespace, path] = /^([a-z0-9_.-]+):([a-z0-9_./-]+)$/.exec(id) ?? [];
  if (!namespace || !path || [namespace, ...path.split("/")].some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid datapack resource ID: ${id}`);
  }
  return join(root, "data", namespace, directory, path + extension);
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export interface ScenarioJavaVersion { runtime: NonNullable<JavaStartOptions["runtime"]>; packFormat: number; functionDirectory: "function" | "functions" }

export async function startScenarioJava(datapack?: ScenarioDatapack, version?: ScenarioJavaVersion): Promise<JavaServer> {
  if (!datapack) return JavaServer.start({ ...(version ? { runtime: version.runtime } : {}) });
  // 有効な空パックを置いて起動する。関数とタグは setup 後に追加する。
  const work = mkdtempSync(join(tmpdir(), "je2be-scenario-"));
  const pack = join(work, PACK);
  try {
    write(join(pack, "pack.mcmeta"), JSON.stringify({
      pack: version ? { description: "je2be scenario", pack_format: version.packFormat } : { description: "je2be scenario", min_format: 121, max_format: 121 },
    }));
    return await JavaServer.start({ ...(version ? { runtime: version.runtime } : {}), datapacks: [pack], initialEnabledPacks: ["vanilla", `file/${PACK}`] });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function loadScenarioDatapack(java: JavaServer, datapack: ScenarioDatapack, log: string[], version?: ScenarioJavaVersion): Promise<void> {
  const root = join(java.worldDirectory, "datapacks", PACK);
  for (const [id, lines] of Object.entries(datapack.functions)) {
    if (id === READY || !Array.isArray(lines) || lines.some((line) => typeof line !== "string" || /[\r\n]/.test(line))) {
      throw new Error(`Invalid scenario function: ${id}`);
    }
    write(resourcePath(root, id, version?.functionDirectory ?? "function", ".mcfunction"), lines.join("\n") + "\n");
  }
  for (const [id, tag] of Object.entries(datapack.functionTags ?? {})) {
    write(resourcePath(root, id, `tags/${version?.functionDirectory ?? "function"}`, ".json"), JSON.stringify(tag));
  }
  write(resourcePath(root, READY, version?.functionDirectory ?? "function", ".mcfunction"), "return 1\n");

  const from = java.log.length;
  const reload = await java.exec("reload");
  log.push(`> reload\n${reload}`);
  // reload は非同期。新しい関数が実行できるまで actions に進まない。
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = await java.exec(`function ${READY}`);
    const errors = java.log.slice(from).filter((line) => /\/ERROR\]|Failed to (load|parse|read)|Missing references/.test(line));
    if (errors.length) throw new Error(`Java scenario datapack failed to load:\n${errors.join("\n")}`);
    if (ready.includes(READY) && ready.startsWith("Running function")) return;
    if (Date.now() >= deadline) {
      throw new Error(`Java scenario datapack reload did not finish: ${reload}\n${ready}\n${java.log.slice(from).join("\n")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
