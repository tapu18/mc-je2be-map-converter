import { CommandParser, type ParsedNode } from "./parser.ts";

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
