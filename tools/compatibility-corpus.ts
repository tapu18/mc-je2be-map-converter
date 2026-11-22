import { corpusContext, type CorpusVersion } from "./corpus-grammar.ts";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { CommandParser, rewriteCommand, selectCommandGrammar, type NbtTag, type ParsedNode, type RewriteContext } from "@je2be/core";
import { loadGrammarTree, loadJavaGrammars } from "@je2be/converter";
import { matchedModifiers, rowKey, terminalShape, type Family, type Row } from "./compatibility-inventory.ts";

type CommandLine = CorpusVersion & {
  map: number;
  source: "cb" | "fn";
  cmd: string;
  dataVersion: number | null;

};
type Definition = { map: number; category: "advancement" | "predicate" | "loot_table"; definition: unknown };
type Usage = { lines: number; definitions: number; maps: Set<number> };

const commandFamilies = new Set<Family>(["command", "particle", "sound", "entity", "component", "effect", "attribute", "game_rule", "click", "hover"]);
const definitionFamilies = new Set<Family>(["advancement_trigger", "loot_function", "loot_condition", "loot_entry"]);
const namespaced = (id: string) => id.includes(":") ? id : "minecraft:" + id;
const eventFamilies = { clickEvent: "click", click_event: "click", hoverEvent: "hover", hover_event: "hover" } as const;

function textReferences(tag: NbtTag, add: (family: Family, id: string) => void): void {
  if (tag.type === "list") {
    for (const child of tag.value) textReferences(child, add);
  } else if (tag.type === "compound") {
    for (const [key, child] of tag.value) {
      if (Object.hasOwn(eventFamilies, key) && child.type === "compound") {
        const action = child.value.get("action");
        if (action?.type === "string") add(eventFamilies[key as keyof typeof eventFamilies], action.value);
      }
      textReferences(child, add);
    }
  }
}

function commandReferences(nodes: ParsedNode[], add: (family: Family, id: string) => void): void {
  let command: string | undefined;
  let previous: ParsedNode | undefined;
  for (const node of nodes) {
    if (!previous || node.jump === "root") command = node.name;
    const value = node.value;
    if (value?.kind === "particle") add("particle", value.id);
    if (command === "gamerule" && previous?.name === "gamerule") {
      add("game_rule", namespaced(node.name === "keepInventory" ? "keep_inventory" : node.name));
    }
    if (value?.kind === "resource" && !value.tag) {
      if ((command === "playsound" || command === "stopsound") && node.name === "sound") add("sound", value.id);
      if (command === "summon" && node.name === "entity") add("entity", value.id);
      if (command === "effect" && node.name === "effect") add("effect", value.id);
      if (command === "attribute" && node.name === "attribute") add("attribute", value.id);
    }
    if (value?.kind === "selector") {
      for (const arg of value.selector.arguments) {
        if (arg.key === "type" && arg.value.kind === "resource" && !arg.value.tag) add("entity", arg.value.id);
      }
    }
    if (value?.kind === "item") {
      for (const component of value.components) add("component", namespaced(component.key));
    }
    if (value?.kind === "itemPredicate") {
      for (const test of value.alternatives.flat()) {
        if (test.op !== "~") add("component", namespaced(test.key));
      }
    }
    if (value?.kind === "text" || (node.parser === "minecraft:style" && value?.kind === "nbt")) textReferences(value.value, add);
    previous = node;
  }
}

function definitionReferences(value: unknown, category: Definition["category"], add: (family: Family, id: string) => void, slot?: string): void {
  if (Array.isArray(value)) {
    for (const child of value) definitionReferences(child, category, add, slot);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") {
        if (category === "advancement" && key === "trigger") add("advancement_trigger", namespaced(child));
        if (category !== "advancement" && key === "condition") add("loot_condition", namespaced(child));
        if (category === "loot_table" && key === "function") add("loot_function", namespaced(child));
        if (category === "loot_table" && key === "type" && (slot === "entries" || slot === "children")) add("loot_entry", namespaced(child));
      } else {
        definitionReferences(child, category, add, key);
      }
    }
  }
}

async function* jsonLines<T>(file: string): AsyncGenerator<T> {
  const input = createReadStream(file);
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) if (line.trim()) yield JSON.parse(line) as T;
  } finally {
    reader.close();
    input.destroy();
  }
}

export async function attachCorpus(rows: Map<string, Row>, files: { commands: string; definitions: string }, base: RewriteContext) {
  const available = loadJavaGrammars();
  if (!available.length) throw new Error("Run npm run setup:grammars before using corpus inputs");
  const contexts = new Map<string, RewriteContext>();
  const usage = new Map<string, Usage>();
  const commands = { total: 0, unavailable: 0, different: 0, macro: 0, invalid: 0, unmatched: 0,
    matched: 0, output: 0, outputWithWarnings: 0 };
  const maps = new Set<number>();
  const familyOutput: Partial<Record<Family, number>> = {};
  const mapsByFamily = new Map<Family, Set<number>>();
  let definitionFiles = 0;

  const collect = (map: number, unit: "lines" | "definitions", collectKeys: (add: (family: Family, id: string) => void) => void, output = false) => {
    const keys = new Set<string>();
    collectKeys((family, id) => {
      const key = rowKey(family, id);
      if (rows.has(key)) keys.add(key);
    });
    for (const key of keys) {
      const entry = usage.get(key) ?? { lines: 0, definitions: 0, maps: new Set<number>() };
      entry[unit]++;
      entry.maps.add(map);
      usage.set(key, entry);
      const family = rows.get(key)!.family;
      if (output && unit === "lines") familyOutput[family] = (familyOutput[family] ?? 0) + 1;
      const familyMaps = mapsByFamily.get(family) ?? new Set<number>();
      familyMaps.add(map);
      mapsByFamily.set(family, familyMaps);
    }
  };

  try {
    for await (const row of jsonLines<CommandLine>(files.commands)) {
      if (!Number.isSafeInteger(row.map) || !["cb", "fn"].includes(row.source) || typeof row.cmd !== "string") throw new Error();
      maps.add(row.map);
      commands.total++;
      const text = row.cmd.trim();
      if (text.startsWith("$")) { commands.macro++; continue; }
      const chosen = corpusContext(row, text, available, base, contexts);
      if (chosen.different) { commands.different++; continue; }
      const context = chosen.context;
      if (!context) { commands.unavailable++; continue; }
      const parsed = context.parser.parse(text);
      if (!parsed.ok) { commands.invalid++; continue; }
      const shape = terminalShape(context.parser.root, parsed.nodes);
      const result = rewriteCommand(text, context);
      const output = result.status === "unchanged" || result.status === "rewritten";
      if (shape && rows.has(rowKey("command", shape))) {
        commands.matched++;
        if (output) {
          commands.output++;
          if (result.issues.some(issue => issue.severity === "warning")) commands.outputWithWarnings++;
        }
      } else {
        commands.unmatched++;
      }
      collect(row.map, "lines", add => {
        if (shape) add("command", shape);
        for (const modifier of matchedModifiers(context.parser.root, parsed.nodes)) add("command", modifier);
        commandReferences(parsed.nodes, add);
      }, output);
    }

    for await (const row of jsonLines<Definition>(files.definitions)) {
      if (!Number.isSafeInteger(row.map) || !["advancement", "predicate", "loot_table"].includes(row.category)) throw new Error();
      maps.add(row.map);
      definitionFiles++;
      collect(row.map, "definitions", add => definitionReferences(row.definition, row.category, add));
    }
  } catch {
    // Parser or JSON exceptions can contain command text, filenames or author IDs.
    throw new Error("Could not collect corpus frequencies. Check the private inputs and versioned grammars locally.");
  }

  for (const [key, row] of rows) {
    const count = usage.get(key);
    row.frequency = {
      lines: commandFamilies.has(row.family) ? (count?.lines ?? 0) : null,
      definitions: definitionFamilies.has(row.family) ? (count?.definitions ?? 0) : null,
      maps: count?.maps.size ?? 0,
    };
  }
  const familyMaps = Object.fromEntries([...mapsByFamily].sort(([a], [b]) => a.localeCompare(b)).map(([family, ids]) => [family, ids.size]));
  return { archivesWithInput: maps.size, familyMaps, familyOutput, definitionFiles, commands };
}
