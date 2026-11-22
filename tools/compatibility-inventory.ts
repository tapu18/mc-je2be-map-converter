import { execFileSync } from "node:child_process";
import { rewriteCommand, type CommandTreeNode, type ParsedNode, type RewriteContext } from "@je2be/core";

export const registries = {
  particle: "particle_type",
  sound: "sound_event",
  entity: "entity_type",
  component: "data_component_type",
  advancement_trigger: "trigger_type",
  loot_function: "loot_function_type",
  loot_condition: "loot_condition_type",
  loot_entry: "loot_pool_entry_type",
  effect: "mob_effect",
  attribute: "attribute",
  game_rule: "game_rule",
} as const;

export type Family = keyof typeof registries | "command" | "click" | "hover";
export const methods = ["native", "rewrite", "runtime", "asset", "approximation", "impossible", "uninvestigated"] as const;

export interface Verdict {
  method: typeof methods[number];
  implementation: "unknown" | "planned" | "partial" | "output" | "loss-only";
  loss: string[] | null;
  issue: number | null;
  evidence: { confidence: "measured" | "estimated" | "unconfirmed"; source: string; scope: string };
}

export interface Row extends Verdict {
  family: Family;
  id: string;
  javaSource: string;
  frequency: { lines: number | null; definitions: number | null; maps: number } | null;
}

export function rowKey(family: Family, id: string): string {
  return family + ":" + id;
}

export function unknown(source: string, issue: number | null = null): Verdict {
  return { method: "uninvestigated", implementation: "unknown", loss: null, issue,
    evidence: { confidence: "unconfirmed", source, scope: "BE compatibility unverified" } };
}

type Step = { name: string; parser?: string };
const pathId = (steps: readonly Step[]) => steps.map(s => s.parser ? `${s.name}<${s.parser}>` : s.name).join(" ");

export function executableShapes(tree: CommandTreeNode): Map<string, { name: string; node: CommandTreeNode }[]> {
  const shapes = new Map<string, { name: string; node: CommandTreeNode }[]>();
  function walk(node: CommandTreeNode, path: { name: string; node: CommandTreeNode }[]): void {
    if (node.executable) shapes.set(pathId(path.map(({ name, node }) => ({ name, ...(node.parser ? { parser: node.parser } : {}) }))), path);
    for (const [name, child] of Object.entries(node.children ?? {})) walk(child, [...path, { name, node: child }]);
  }
  walk(tree, []);
  return shapes;
}

// Replay the report's redirects against the parsed path, retaining only terminal executable nodes.
export function terminalShape(tree: CommandTreeNode, nodes: readonly ParsedNode[]): string | undefined {
  let cursor = tree;
  let path: Step[] = [];
  for (const node of nodes) {
    if (node.jump === "root") {
      cursor = tree;
      path = [];
    } else if (cursor.redirect) {
      const redirect = cursor.redirect;
      cursor = tree;
      path = [];
      for (const name of redirect) {
        const destination: CommandTreeNode | undefined = cursor.children?.[name];
        if (!destination) throw new Error("Invalid Java grammar redirect");
        cursor = destination;
        path.push({ name, ...(cursor.parser ? { parser: cursor.parser } : {}) });
      }
    }
    const child: CommandTreeNode | undefined = cursor.children?.[node.name];
    if (!child) throw new Error("Parsed node absent from Java grammar");
    cursor = child;
    path.push(node);
  }
  return cursor.executable ? pathId(path) : undefined;
}

export function textActions(jar: string, kind: "Click" | "Hover"): string[] {
  // The reports omit these codecs. Read the serialized names from the fixed server's enum initializer.
  const className = `net.minecraft.network.chat.${kind}Event$Action`;
  const disassembly = execFileSync("javap", ["-J-Duser.language=en", "-p", "-c", "-classpath", jar, className], { encoding: "utf8" });
  const fields = disassembly.split("\n").filter(line => line.trim().startsWith(`public static final ${className} `));
  const initializer = disassembly.split("static {};")[1] ?? "";
  const names = [...initializer.matchAll(/\/\/ String ([a-z][a-z_0-9]*)\s*$/gm)].map(match => match[1]!);
  if (!names.length || names.length !== fields.length || new Set(names).size !== names.length) {
    throw new Error(`Could not enumerate serialized ${kind}Event actions from the Java server`);
  }
  return names.sort();
}

// Public, synthetic probes for common argument types. Unsupported types stay uninvestigated.
const examples: Record<string, string> = {
  "brigadier:bool": "true", "brigadier:string": "probe",
  "minecraft:entity": "@s", "minecraft:game_profile": "@s", "minecraft:score_holder": "probe",
  "minecraft:block_pos": "0 0 0", "minecraft:vec3": "0 0 0", "minecraft:column_pos": "0 0",
  "minecraft:vec2": "0 0", "minecraft:rotation": "0 0", "minecraft:angle": "0",
  "minecraft:block_state": "minecraft:stone", "minecraft:block_predicate": "minecraft:stone",
  "minecraft:item_stack": "minecraft:stone", "minecraft:item_predicate": "minecraft:stone",
  "minecraft:nbt_compound_tag": "{}", "minecraft:nbt_tag": "1", "minecraft:nbt_path": "probe",
  "minecraft:component": '{"text":"probe"}', "minecraft:message": "probe", "minecraft:objective": "probe",
  "minecraft:time": "1", "minecraft:dimension": "minecraft:overworld",
  "minecraft:entity_anchor": "feet", "minecraft:swizzle": "xyz", "minecraft:gamemode": "survival",
  "minecraft:operation": "+=", "minecraft:objective_criteria": "dummy", "minecraft:scoreboard_slot": "sidebar",
  "minecraft:int_range": "1", "minecraft:particle": "minecraft:flame",
};

function probeArgument(name: string, node: CommandTreeNode): string | undefined {
  const parser = node.parser ?? "";
  if (["brigadier:integer", "brigadier:long", "brigadier:double", "brigadier:float"].includes(parser)) {
    const min = Number(node.properties?.min ?? -Infinity);
    const max = Number(node.properties?.max ?? Infinity);
    return String(Math.min(max, Math.max(min, name === "count" ? 1 : 0)));
  }
  if (name === "sound" && parser.startsWith("minecraft:resource")) return "minecraft:entity.experience_orb.pickup";
  if (node.properties?.registry === "minecraft:mob_effect") return "minecraft:speed";
  if (node.properties?.registry === "minecraft:time_marker") return "minecraft:day";
  return Object.hasOwn(examples, parser) ? examples[parser] : undefined;
}

export function probeShape(context: RewriteContext, id: string, path: { name: string; node: CommandTreeNode }[]): Verdict {
  const parts = path.map(({ name, node }) => node.type === "literal" ? name : probeArgument(name, node));
  const source = "packages/core/src/command/rewrite.ts";
  if (parts.includes(undefined)) return unknown(source, 112);
  const probe = parts.join(" ");
  const parsed = context.parser.parse(probe);
  if (!parsed.ok || terminalShape(context.parser.root, parsed.nodes) !== id) return unknown(source, 112);
  const result = rewriteCommand(probe, context);
  if (result.status !== "rewritten" && result.status !== "unchanged") {
    const fallback = unknown(source, 112);
    if (result.status === "unsupported") fallback.evidence.scope = result.issues.map(issue => issue.message).join(" / ");
    return fallback;
  }
  const warnings = result.issues.map(issue => issue.message);
  return {
    method: warnings.length ? "approximation" : result.status === "rewritten" ? "rewrite" : "native",
    implementation: "partial", loss: warnings.length ? warnings : null, issue: 112,
    evidence: { confidence: "unconfirmed", source, scope: `Static output for one synthetic input: ${probe}` },
  };
}
