import { isMacroKey, supportsMacroArgument, type MacroArgument } from "./macro-arguments.ts";
import { normalizeCommandIR } from "./normalize-command.ts";
import { CommandParser, toCommandIR, type CommandIR, type ParsedArgumentGrammar, type ParsedNode } from "./parser.ts";

/** A successful probe is an example, not proof that all substitutions share its shape. */
export interface MacroProbe {
  nodes: ParsedNode[];
  holes: { name: string; start: number; end: number; argument: string; parser: string; offset: number }[];
}

/** Parse one concrete substitution while retaining each hole's original position.
 * This deliberately rejects holes crossing argument boundaries or landing in literals.
 * Arbitrary substitutions can change the grammar; callers must not treat a probe as a guarantee.
 */
export function probeMacroTemplate(parser: CommandParser, source: string, replacement: string): MacroProbe | undefined {
  if (!source.startsWith("$") || !replacement) return undefined;
  const holes = [...source.matchAll(/\$\(([^()]+)\)/g)];
  if (!holes.length) return undefined;
  let concrete = "";
  let cursor = 1;
  const positions: { name: string; start: number; end: number; concreteStart: number; concreteEnd: number }[] = [];
  for (const hole of holes) {
    const start = hole.index;
    concrete += source.slice(cursor, start);
    const concreteStart = concrete.length;
    concrete += replacement;
    positions.push({ name: hole[1]!, start, end: start + hole[0].length, concreteStart, concreteEnd: concrete.length });
    cursor = start + hole[0].length;
  }
  concrete += source.slice(cursor);
  const result = parser.parse(concrete);
  if (!result.ok) return undefined;
  const mapped: MacroProbe["holes"] = [];
  for (const hole of positions) {
    const node = result.nodes.find(n => n.kind === "argument" && n.start <= hole.concreteStart && n.end >= hole.concreteEnd);
    if (!node?.parser) return undefined;
    mapped.push({ name: hole.name, start: hole.start, end: hole.end, argument: node.name, parser: node.parser, offset: hole.concreteStart - node.start });
  }
  return { nodes: result.nodes, holes: mapped };
}

interface MacroHole {
  key: string;
  start: number;
  end: number;
}

type MacroCompilation = { ok: true; ir: CommandIR } | { ok: false; reason: string; start: number; end: number };

const holePattern = /\$\(([^()]*)\)/g;

// A successful sample locates the argument boundaries. The grammar checks below constrain
// the paths we accept, and each replacement must be consumed by its own parser at runtime.
const samples = ["0", "1", "64", "true", "x", '"x"', "{}", "[]", "=", "0 0", "0 0 0", "x x", "x x x", "@s"];

export function compileMacroTemplate(parser: CommandParser, source: string, version: string): MacroCompilation {
  const holes: MacroHole[] = [...source.matchAll(holePattern)].map(match => ({
    key: match[1]!, start: match.index, end: match.index + match[0].length,
  }));
  const issue = (reason: string, hole = holes[0]) =>
    ({ok: false as const, reason, start: hole?.start ?? 0, end: hole?.end ?? source.length});
  if (!source.startsWith("$") || !holes.length || source.replace(holePattern, "").includes("$(")) {
    return issue("invalid macro placeholder");
  }
  const invalid = holes.find(hole => !isMacroKey(hole.key));
  if (invalid) return issue("invalid macro placeholder", invalid);

  const compile = (replacement: string): MacroCompilation | undefined => {
    let cursor = 1;
    let concrete = "";
    const positions = holes.map(hole => {
      concrete += source.slice(cursor, hole.start);
      const start = concrete.length;
      concrete += replacement;
      cursor = hole.end;
      return {hole, start, end: concrete.length};
    });
    concrete += source.slice(cursor);
    const grammar = new Map<number, ParsedArgumentGrammar>();
    const parsed = parser.parse(concrete, grammar);
    if (!parsed.ok) return;

    const slots = new Map<ParsedNode, typeof positions>();
    for (const position of positions) {
      const node = parsed.nodes.find(node => node.start <= position.start && position.end <= node.end);
      if (!node) return issue("macro hole crosses an argument boundary", position.hole);
      if (node.kind === "literal") return issue("macro hole can change command shape", position.hole);
      const group = slots.get(node) ?? [];
      group.push(position);
      slots.set(node, group);
    }

    const args: MacroArgument[] = [];
    for (const [node, group] of slots) {
      const metadata = grammar.get(node.start)!;
      const firstHole = group[0]!.hole;
      if (!supportsMacroArgument(node.parser!)) {
        return issue(`macro argument type ${node.parser} is unsupported or requires an ID mapping`, firstHole);
      }
      // Literal precedence depends on the first word. A prefix ending before that
      // word ends can only rule out literals with a different prefix.
      const prefix = concrete.slice(node.start, group[0]!.start);
      const space = prefix.indexOf(" ");
      const hasLiteral = metadata.competingLiterals.some(literal =>
        space < 0 ? literal.startsWith(prefix) : literal === prefix.slice(0, space));
      if (metadata.competingArgument || hasLiteral) return issue("macro hole can change command shape", firstHole);

      const parts: MacroArgument["parts"] = [];
      let offset = node.start;
      for (const {start, end, hole} of group) {
        parts.push(concrete.slice(offset, start), {key: hole.key});
        offset = end;
      }
      parts.push(concrete.slice(offset, node.end));
      const properties: NonNullable<MacroArgument["properties"]> = {};
      for (const key of ["min", "max"] as const) {
        const bound = metadata.properties?.[key];
        if (typeof bound === "number" || typeof bound === "bigint") properties[key] = bound;
      }
      const type = metadata.properties?.type;
      if (typeof type === "string") properties.type = type;
      args.push({start: node.start, end: node.end, parser: node.parser!, parts, properties});
    }
    const ir = toCommandIR(concrete, parsed.nodes);
    return {ok: true, ir: {...ir, macro: {version, textFormat: parser.options.textFormat, arguments: args}}};
  };

  let result: MacroCompilation | undefined;
  for (const sample of samples) {
    const candidate = compile(sample);
    if (!candidate) continue;
    if (!candidate.ok) return candidate;
    if (result?.ok && result.ir.macro!.arguments.some((argument, i) => {
      const other = candidate.ir.macro!.arguments[i];
      return !other || other.parser !== argument.parser || JSON.stringify(other.parts) !== JSON.stringify(argument.parts);
    })) return issue("macro values produce different argument boundaries");
    result ??= candidate;
  }
  if (!result?.ok) return issue("cannot determine fixed command shape and argument boundaries for macro");
  const normalized = normalizeCommandIR(result.ir, version);
  if (!normalized.ok) return issue(normalized.reason);
  return result;
}
