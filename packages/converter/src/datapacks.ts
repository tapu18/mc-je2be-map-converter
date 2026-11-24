import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import AdmZip from "adm-zip";
import { CommandParser, readPackFormatRange, selectCommandGrammar, serializeCommandIR, toCommandIR } from "@je2be/core";
import { loadGrammarTree, loadJavaGrammars } from "./java-grammars.ts";
import { readJavaValidationContext } from "./validation-context.ts";

/** Preserve pack order and tag definitions, including replace and optional references. */
export function collectDatapacks(world: string) {
  const context = readJavaValidationContext(world);
  const grammars = loadJavaGrammars();
  const packs: { name: string; grammar?: string; functions: Record<string, string[]>; tags: Record<string, unknown> }[] = [];
  const diagnostics: { pack: string; path: string; reason: string }[] = [];
  const omitted = new Set<string>();
  for (const entry of context.packOrder) if ("builtin" in entry && entry.builtin !== "vanilla") diagnostics.push({ pack: entry.builtin, path: "", reason: "builtin pack not bundled" });
  for (const path of context.datapacks) {
    const name = basename(path);
    const entries = new Map<string, Buffer>();
    if (lstatSync(path).isDirectory()) {
      const walk = (dir: string, prefix = "") => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const key = prefix + entry.name;
          if (entry.isSymbolicLink()) throw new Error(`datapack symlink: ${key}`);
          if (entry.isDirectory()) walk(join(dir, entry.name), key + "/");
          else if (entry.isFile()) entries.set(key, readFileSync(join(dir, entry.name)));
        }
      };
      walk(path);
    } else {
      for (const entry of new AdmZip(path).getEntries()) if (!entry.isDirectory) {
        if (entries.has(entry.entryName)) throw new Error(`duplicate datapack entry: ${entry.entryName}`);
        entries.set(entry.entryName, entry.getData());
      }
    }
    let metadata: unknown;
    try { metadata = JSON.parse(entries.get("pack.mcmeta")?.toString("utf8") ?? ""); } catch { metadata = undefined; }
    if (metadata && typeof metadata === "object" && "overlays" in metadata) {
      omitted.add("overlays");
      diagnostics.push({ pack: name, path: "pack.mcmeta", reason: "pack overlays not bundled" });
    }
    const range = readPackFormatRange(metadata);
    const selection = selectCommandGrammar(grammars, range ? { packFormatRange: range } : {});
    const grammar = selection.ok ? selection.grammar : undefined;
    if (!grammar) diagnostics.push({ pack: name, path: "pack.mcmeta", reason: range ? selection.ok ? "" : selection.reason : "invalid pack format" });
    const parser = grammar ? new CommandParser(loadGrammarTree(grammar), { textFormat: grammar.textFormat }) : undefined;
    const pack: typeof packs[number] = { name, ...(grammar ? { grammar: grammar.version } : {}), functions: {}, tags: {} };
    for (const [key, bytes] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
      const match = /^data\/([^/]+)\/(functions?|tags\/functions?)\/(.+)\.(mcfunction|json)$/.exec(key);
      if (match && ((match[2]!.startsWith("tags/") && match[4] === "json") || (!match[2]!.startsWith("tags/") && match[4] === "mcfunction"))) {
        if (grammar && match[2]!.replace("tags/", "") !== grammar.source.functionDirectory) { omitted.add(match[2]!); continue; }
        const id = `${match[1]}:${match[3]}`;
        if (match[2]!.startsWith("tags/")) {
          try { pack.tags[id] = JSON.parse(bytes.toString("utf8")); } catch { diagnostics.push({ pack: name, path: key, reason: "invalid tag JSON" }); }
        } else if (parser && grammar) {
          const lines: string[] = [];
          let valid = true;
          for (const [index, raw] of bytes.toString("utf8").split(/\r?\n/).entries()) {
            const line = raw.trim();
            if (!line || line.startsWith("#")) continue;
            const parsed = parser.parse(line);
            if (!parsed.ok || line.startsWith("$")) { diagnostics.push({ pack: name, path: `${key}:${index + 1}`, reason: line.startsWith("$") ? "macro unsupported" : "command parse failed" }); valid = false; continue; }
            lines.push(serializeCommandIR({ grammarVersion: grammar.version, textFormat: grammar.textFormat, ir: toCommandIR(line, parsed.nodes) }));
          }
          if (valid) pack.functions[id] = lines;
        } else diagnostics.push({ pack: name, path: key, reason: "grammar unavailable" });
      } else if (key.startsWith("data/")) {
        const parts = key.split("/");
        if (parts.length >= 4) omitted.add(parts[2]!);
      }
    }
    packs.push(pack);
  }
  return { packs, report: { functions: packs.reduce((n, p) => n + Object.keys(p.functions).length, 0), omitted: [...omitted].sort(), diagnostics } };
}
