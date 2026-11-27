// 旧 JE のコマンド文法を、固定サーバーから別枠で生成する（#58）。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { textFormatFor, type CommandGrammar, type CommandTreeNode } from "@je2be/core";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const grammarRoot = join(root, "servers", "grammars");
const fixed = JSON.parse(readFileSync(join(root, "tools", "servers.json"), "utf8")) as {
  java: Omit<JavaGrammarSource, "functionDirectory"> & { dataVersion: number };
};
export const fixedJavaDataVersion = fixed.java.dataVersion;
export const fixedJavaVersion = fixed.java.version;

/** Preserve integer long bounds before JSON.parse can round them. */
export function parseCommandTree(json: string): CommandTreeNode {
  const tree = JSON.parse(json, (key: string, value: unknown, context?: { source?: string }) => {
    if ((key === "min" || key === "max") && typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) return BigInt(context.source);
    return value;
  }) as CommandTreeNode;
  const visit = (node: CommandTreeNode): void => {
    if (node.parser !== "brigadier:long" && node.properties) {
      for (const key of ["min", "max"]) if (typeof node.properties[key] === "bigint") node.properties[key] = Number(node.properties[key]);
    }
    for (const child of Object.values(node.children ?? {})) visit(child);
  };
  visit(tree);
  return tree;
}

export interface JavaGrammarSource {
  version: string;
  url: string;
  sha1: string;
  functionDirectory: "function" | "functions";
}

export interface JavaGrammarInstallation extends CommandGrammar {
  source: JavaGrammarSource;
  java: string;
  serverDirectory: string;
  commandsPath: string;
  commandsSha256: string;
  packMinor: number;
}

type GrammarDescriptor = Omit<JavaGrammarInstallation, "java" | "serverDirectory" | "commandsPath">;

function installationFromDescriptor(descriptor: GrammarDescriptor, directory: string): JavaGrammarInstallation {
  // Ignore path fields in old descriptors as well: their original checkout may no longer exist.
  const { java: _java, serverDirectory: _serverDirectory, commandsPath: _commandsPath, ...metadata } = descriptor as JavaGrammarInstallation;
  return {
    ...metadata,
    java: join(dirname(directory), "jre", "bin", "java"),
    serverDirectory: join(directory, descriptor.version, "server"),
    commandsPath: join(directory, descriptor.version, "generated", "reports", "commands.json"),
  };
}

function descriptorFromInstallation(installation: JavaGrammarInstallation): GrammarDescriptor {
  const { java: _java, serverDirectory: _serverDirectory, commandsPath: _commandsPath, ...descriptor } = installation;
  return descriptor;
}

function assertSource(source: JavaGrammarSource): void {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(source.version)) throw new Error("invalid grammar release version");
  if (!/^[0-9a-f]{40}$/.test(source.sha1)) throw new Error("invalid grammar server SHA-1");
  if (typeof source.url !== "string" || !source.url.startsWith("https://")) throw new Error("grammar server URL must use HTTPS");
  if (!["function", "functions"].includes(source.functionDirectory)) throw new Error("invalid function directory");
}

export function javaGrammarSources(): JavaGrammarSource[] {
  const extra = JSON.parse(readFileSync(join(root, "tools", "java-grammars.json"), "utf8")) as { versions: JavaGrammarSource[] };
  const { version, url, sha1 } = fixed.java;
  const sources: JavaGrammarSource[] = [...extra.versions, { version, url, sha1, functionDirectory: "function" }];
  for (const source of sources) assertSource(source);
  if (new Set(sources.map((s) => s.version)).size !== sources.length) throw new Error("duplicate grammar release version");
  return sources;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function serverArchive(source: JavaGrammarSource): Promise<string> {
  const cache = process.env.JE2BE_GRAMMAR_CACHE ?? join(homedir(), ".cache", "je2be-grammars");
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `${source.sha1}.jar`);
  const fixed = join(root, "servers", `java-${source.version}`, "server.jar");
  if (!existsSync(file) && existsSync(fixed)) copyFileSync(fixed, file);
  if (!existsSync(file)) {
    let bytes: Buffer | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(source.url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${source.url}`);
        bytes = Buffer.from(await response.arrayBuffer());
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes!);
    renameSync(temporary, file);
  }
  const actual = createHash("sha1").update(readFileSync(file)).digest("hex");
  if (actual !== source.sha1) throw new Error(`Java ${source.version}: server SHA-1 mismatch`);
  return file;
}

/** サーバー配布物の version.json から値を取る。DataVersion を記憶や版の大小から補わない。 */
function versionMetadata(jar: string, output: string): { id: string; dataVersion: number; packFormat: number; packMinor: number } {
  const entries = execFileSync("unzip", ["-Z1", jar], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\n");
  const inner = entries.filter((name) => /^META-INF\/versions\/[^/]+\/[^/]+\.jar$/.test(name));
  if (inner.length !== 1) throw new Error(`expected one bundled server jar: ${jar}`);
  const temporary = join(output, "version-server.jar");
  try {
    writeFileSync(temporary, execFileSync("unzip", ["-p", jar, inner[0]!], { maxBuffer: 128 * 1024 * 1024 }));
    const version = JSON.parse(execFileSync("unzip", ["-p", temporary, "version.json"], { encoding: "utf8" })) as {
      id: string; world_version: number; pack_version: { data?: number; data_major?: number; data_minor?: number };
    };
    const format = version.pack_version.data ?? version.pack_version.data_major;
    if (!Number.isSafeInteger(version.world_version) || !Number.isSafeInteger(format)) throw new Error("invalid server version metadata");
    return { id: version.id, dataVersion: version.world_version, packFormat: format!, packMinor: version.pack_version.data_minor ?? 0 };
  } finally { rmSync(temporary, { force: true }); }
}

export async function setupJavaGrammar(source: JavaGrammarSource): Promise<JavaGrammarInstallation> {
  assertSource(source);
  const archive = await serverArchive(source);
  const output = join(grammarRoot, source.version);
  const serverDirectory = join(output, "server");
  const descriptor = join(output, "grammar.json");
  // データ生成器は出力先の古いファイルを消すので、サーバーの作業先とは分ける。
  const generated = join(output, "generated");
  const commandsPath = join(generated, "reports", "commands.json");
  if (existsSync(descriptor) && existsSync(commandsPath)) {
    const previous = installationFromDescriptor(JSON.parse(readFileSync(descriptor, "utf8")) as GrammarDescriptor, grammarRoot);
    if (previous.version === source.version && previous.source.sha1 === source.sha1 && previous.source.functionDirectory === source.functionDirectory
      && existsSync(join(serverDirectory, "server.jar"))
      && createHash("sha1").update(readFileSync(join(serverDirectory, "server.jar"))).digest("hex") === source.sha1
      && previous.commandsSha256 === sha256(readFileSync(commandsPath))) {
      writeFileSync(descriptor, JSON.stringify(descriptorFromInstallation(previous), null, 2) + "\n");
      return previous;
    }
  }
  mkdirSync(serverDirectory, { recursive: true });
  copyFileSync(archive, join(serverDirectory, "server.jar"));
  writeFileSync(join(serverDirectory, "eula.txt"), "eula=true\n");
  const metadata = versionMetadata(archive, output);
  if (metadata.id !== source.version) throw new Error(`expected Java ${source.version}, got ${metadata.id}`);
  if (source.version === fixed.java.version && metadata.dataVersion !== fixedJavaDataVersion) {
    throw new Error(`expected DataVersion ${fixedJavaDataVersion}, got ${metadata.dataVersion}`);
  }
  const java = join(root, "servers", "jre", "bin", "java");
  execFileSync(java, ["-Xmx1G", "-DbundlerMainClass=net.minecraft.data.Main", "-jar", "server.jar", "--reports", "--output", generated], {
    cwd: serverDirectory, stdio: "pipe", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  const installation: JavaGrammarInstallation = {
    version: source.version, dataVersion: metadata.dataVersion, packFormat: metadata.packFormat,
    textFormat: textFormatFor(metadata.dataVersion), packMinor: metadata.packMinor,
    source, java, serverDirectory, commandsPath, commandsSha256: sha256(readFileSync(commandsPath)),
  };
  writeFileSync(descriptor, JSON.stringify(descriptorFromInstallation(installation), null, 2) + "\n");
  return installation;
}

export function loadJavaGrammars(directory = grammarRoot): JavaGrammarInstallation[] {
  return javaGrammarSources().flatMap((source) => {
    const file = join(directory, source.version, "grammar.json");
    if (!existsSync(file)) return [];
    const installation = installationFromDescriptor(JSON.parse(readFileSync(file, "utf8")) as GrammarDescriptor, directory);
    if (installation.version !== source.version || installation.source.sha1 !== source.sha1 || sha256(readFileSync(installation.commandsPath)) !== installation.commandsSha256) throw new Error(`stale/corrupt grammar: ${source.version}`);
    return [installation];
  });
}

export function loadGrammarTree(grammar: JavaGrammarInstallation): CommandTreeNode {
  const bytes = readFileSync(grammar.commandsPath);
  if (sha256(bytes) !== grammar.commandsSha256) throw new Error(`corrupt grammar: ${grammar.version}`);
  return parseCommandTree(bytes.toString("utf8"));
}
