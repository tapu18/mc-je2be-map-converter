import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { CommandParser, comparePackVersions, compileMacroTemplate, normalizeCommandIR, readPackFormatRange, rewriteNativeCommand, runtimeFamilies, selectCommandGrammar, serializeCommandIR, toCommandIR, type MappingLookup } from "@je2be/core";
import { loadBlockDefaults } from "./block-defaults.ts";
import { fixedJavaDataVersion, loadGrammarTree, loadJavaGrammars } from "./java-grammars.ts";
import { readJavaValidationContext } from "./validation-context.ts";

/** Preserve pack order and tag definitions, including replace and optional references. */
export function collectDatapacks(world: string, rewrite?: {mappings: MappingLookup; blocksJson: string}) {
  const context = readJavaValidationContext(world);
  const grammars = loadJavaGrammars();
  const packs: { name: string; grammar?: string; functions: Record<string, string[]>; tags: Record<string, unknown> }[] = [];
  const diagnostics: { pack: string; path: string; reason: string; start?: number; end?: number; command?: string; error?: string }[] = [];
  const omitted = new Set<string>();
  const nativeCommands = new Map<string, string | null>();
  /** Every function line offered for delegation, in reading order. `reason` is set when this site's own rewrite failed. */
  const nativeSites: { line: string; pack: string; path: string; start: number; end: number; reason?: string; error?: string }[] = [];
  const candidates = new Map<string, Map<string, string | null>>();
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
      const overlays = metadata.overlays as { entries?: unknown } | undefined;
      const worldGrammar = selectCommandGrammar(grammars, context.dataVersion === undefined ? {} : { dataVersion: context.dataVersion });
      const definitions = overlays && Array.isArray(overlays.entries) ? overlays.entries : undefined;
      if (!worldGrammar.ok || !definitions) {
        omitted.add("overlays");
        diagnostics.push({ pack: name, path: "pack.mcmeta", reason: "overlay selection unavailable" });
      } else for (const definition of definitions) {
        if (!definition || typeof definition !== "object") { omitted.add("overlays"); diagnostics.push({ pack: name, path: "pack.mcmeta", reason: "invalid overlay" }); continue; }
        const overlay = definition as Record<string, unknown>;
        const directory = overlay.directory;
        const overlayRange = readPackFormatRange({ pack: { ...overlay, ...(overlay.formats === undefined ? {} : { supported_formats: overlay.formats }) } });
        if (typeof directory !== "string" || !/^[a-z0-9_.-]+$/.test(directory) || directory === "." || directory === ".." || !overlayRange) {
          omitted.add("overlays"); diagnostics.push({ pack: name, path: "pack.mcmeta", reason: "invalid overlay" }); continue;
        }
        const version: [number, number] = [worldGrammar.grammar.packFormat, worldGrammar.grammar.packMinor ?? 0];
        if (comparePackVersions(version, overlayRange.min) < 0 || comparePackVersions(version, overlayRange.max) > 0) continue;
        for (const [key, value] of [...entries]) if (key.startsWith(`${directory}/data/`)) entries.set(key.slice(directory.length + 1), value);
      }
    }
    const range = readPackFormatRange(metadata);
    const selection = selectCommandGrammar(grammars, range ? { packFormatRange: range } : {});
    const grammar = selection.ok ? selection.grammar : undefined;
    if (!grammar) diagnostics.push({ pack: name, path: "pack.mcmeta", reason: range ? selection.ok ? "" : selection.reason : "invalid pack format" });
    const parser = grammar ? new CommandParser(loadGrammarTree(grammar), grammar) : undefined;
    const nativeContext = rewrite && grammar && parser ? {
      parser, mappings: rewrite.mappings,
      blockDefaults: loadBlockDefaults(grammar.dataVersion === fixedJavaDataVersion ? rewrite.blocksJson : join(dirname(grammar.commandsPath), "blocks.json")),
    } : undefined;
    const rewritten = new Map<string, ReturnType<typeof rewriteNativeCommand>>();
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
          const nativeLines: { line: string; path: string; start: number; end: number }[] = [];
          let valid = true;
          for (const [index, raw] of bytes.toString("utf8").split(/\r?\n/).entries()) {
            const line = raw.trim();
            if (!line || line.startsWith("#")) continue;
            if (line.startsWith("$")) {
              const template = compileMacroTemplate(parser, line, grammar.version);
              if (template.ok) {
                lines.push(serializeCommandIR({ grammarVersion: grammar.version, textFormat: grammar.textFormat, ir: template.ir }));
              } else {
                const indent = raw.length - raw.trimStart().length;
                diagnostics.push({ pack: name, path: `${key}:${index + 1}`, reason: template.reason, start: indent + template.start, end: indent + template.end, command: line });
                valid = false;
              }
              continue;
            }
            const parsed = parser.parse(line);
            if (!parsed.ok) { diagnostics.push({ pack: name, path: `${key}:${index + 1}`, reason: "command parse failed", command: line, error: `${parsed.error.message}（${parsed.error.position + 1}文字目）` }); valid = false; continue; }
            const normalized = normalizeCommandIR(toCommandIR(line, parsed.nodes), grammar.version);
            if (!normalized.ok) {
              const { reason, start, end } = normalized;
              const indent = raw.length - raw.trimStart().length;
              diagnostics.push({ pack: name, path: `${key}:${index + 1}`, reason, start: indent + start, end: indent + end, command: line });
              valid = false;
              continue;
            }
            lines.push(serializeCommandIR({ grammarVersion: grammar.version, textFormat: grammar.textFormat, ir: normalized.ir }));
            let terminal = normalized.ir;
            while (terminal.command?.name === "return" && terminal.command.run) terminal = terminal.command.run;
            if (nativeContext && terminal.command && !["function", "return"].includes(terminal.command.name)
              && !runtimeFamilies.some(family => family.assess({status: "parsed", ir: terminal}).status === "runtime")) {
              const nodes = terminal.command.nodes;
              const indent = raw.length - raw.trimStart().length;
              nativeLines.push({ line, path: `${key}:${index + 1}`, start: indent + (nodes[0]?.start ?? 0), end: indent + (nodes.at(-1)?.end ?? line.length) });
            }
          }
          if (valid) {
            pack.functions[id] = lines;
            if (nativeContext) for (const site of nativeLines) {
              const { line } = site;
              if (!rewritten.has(line)) rewritten.set(line, rewriteNativeCommand(line, nativeContext));
              const result = rewritten.get(line)!;
              const candidate = result.status === "rewritten" || result.status === "unchanged" ? result.command : null;
              const failure = result.status === "invalid" ? `${result.message}（${result.position + 1}文字目）`
                : result.status === "unsupported" ? result.issues.filter(issue => issue.severity === "unsupported").map(issue => issue.message).join("; ") || "unsupported" : undefined;
              nativeSites.push({ ...site, pack: name, ...(failure === undefined ? {} : { reason: "native rewrite unsupported", error: failure }) });
              if (!candidates.has(line)) candidates.set(line, new Map());
              candidates.get(line)!.set(grammar.version, candidate);
              // The runtime receives only the source line. Conflicting rewrites across grammar versions are ambiguous.
              nativeCommands.set(line, nativeCommands.has(line) && nativeCommands.get(line) !== candidate ? null : candidate);
            }
          }
        } else diagnostics.push({ pack: name, path: key, reason: "grammar unavailable" });
      } else if (key.startsWith("data/")) {
        const parts = key.split("/");
        if (parts.length >= 4) omitted.add(parts[2]!);
      }
    }
    packs.push(pack);
  }
  const nativeLines = { delegated: 0, undelegated: 0 };
  for (const site of nativeSites) {
    if (nativeCommands.get(site.line) !== null) { nativeLines.delegated++; continue; }
    nativeLines.undelegated++;
    const { pack, path, start, end, line: command } = site;
    if (site.reason) diagnostics.push({ pack, path, reason: site.reason, start, end, command, ...(site.error ? { error: site.error } : {}) });
    else {
      const versions = [...candidates.get(command)!].map(([version, candidate]) => `${version}: ${candidate ?? "unsupported"}`).join("; ");
      diagnostics.push({ pack, path, reason: "native rewrite differs across grammar versions", start, end, command, error: versions });
    }
  }
  return {
    packs,
    nativeCommands: [...nativeCommands].filter((entry): entry is [string, string] => entry[1] !== null),
    report: { functions: packs.reduce((n, p) => n + Object.keys(p.functions).length, 0), omitted: [...omitted].sort(), nativeLines, diagnostics },
  };
}
