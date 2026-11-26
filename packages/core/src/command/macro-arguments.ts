import type { NbtCompound, NbtTag } from "../nbt/nbt.ts";
import { ARGUMENT_PARSERS, type ArgumentOptions, type ArgumentValue } from "./arguments.ts";
import { normalizeCommandIR } from "./normalize-command.ts";
import type { CommandIR, ParsedNode } from "./parser.ts";
import { CommandSyntaxError, StringReader } from "./reader.ts";

export interface MacroArgument {
  start: number;
  end: number;
  parser: string;
  properties?: { type?: string; min?: number | bigint; max?: number | bigint };
  parts: (string | { key: string })[];
}

export interface MacroTemplate extends ArgumentOptions {
  version: string;
  arguments: MacroArgument[];
}

const supportedParsers = new Set([
  "brigadier:bool", "brigadier:integer", "brigadier:long", "brigadier:float", "brigadier:double", "brigadier:string",
  "minecraft:score_holder", "minecraft:objective", "minecraft:team", "minecraft:operation",
  "minecraft:block_pos", "minecraft:column_pos", "minecraft:vec3", "minecraft:vec2", "minecraft:rotation", "minecraft:angle",
  "minecraft:nbt_tag", "minecraft:nbt_compound_tag", "minecraft:nbt_path", "minecraft:component", "minecraft:message",
  "minecraft:int_range", "minecraft:float_range", "minecraft:time", "minecraft:function",
]);

export function supportsMacroArgument(parser: string): boolean {
  return supportedParsers.has(parser);
}

export function isMacroKey(key: string): boolean {
  // Java checks each UTF-16 character with Character.isLetterOrDigit.
  return [...key].every(character => character.length === 1 && /^[\p{L}\p{Nd}_]$/u.test(character));
}

function quoteSnbt(value: string): string {
  const first = /["']/.exec(value)?.[0];
  const quote = first === '"' ? "'" : '"';
  return quote + value.replaceAll("\\", "\\\\").replaceAll(quote, "\\" + quote) + quote;
}

function compoundSnbt(tag: NbtTag): string {
  switch (tag.type) {
    case "compound": return "{" + [...tag.value].map(([key, value]) =>
      (/^[A-Za-z0-9._+-]+$/.test(key) ? key : quoteSnbt(key)) + ":" + compoundSnbt(value)).join(",") + "}";
    case "list": return "[" + tag.value.map(compoundSnbt).join(",") + "]";
    case "byteArray": return "[B;" + Array.from(tag.value, n => n + "B").join(",") + "]";
    case "intArray": return "[I;" + tag.value.join(",") + "]";
    case "longArray": return "[L;" + Array.from(tag.value, n => n + "L").join(",") + "]";
    case "string": return quoteSnbt(tag.value);
    case "byte": return tag.value + "b";
    case "short": return tag.value + "s";
    case "long": return tag.value + "L";
    case "float": return tag.value + "f";
    case "double": return tag.value + "d";
    case "int": return String(tag.value);
  }
}

/** Java formats top-level floating-point macro values without an exponent or type suffix. */
function macroDecimal(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const [mantissa, exponent = "0"] = String(Math.abs(value)).split("e") as [string, string?];
  const [integer, fraction = ""] = mantissa.split(".") as [string, string?];
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  const whole = point <= 0 ? "0" : digits.slice(0, point).padEnd(point, "0");
  const decimals = point < 0 ? "0".repeat(-point) + digits : digits.slice(point);
  const scale = 10n ** 15n;
  let units = BigInt(whole) * scale + BigInt(decimals.slice(0, 15).padEnd(15, "0"));
  const next = decimals[15];
  if (next && (next > "5" || (next === "5" && (/[1-9]/.test(decimals.slice(16)) || units % 2n === 1n)))) units++;
  const tail = (units % scale).toString().padStart(15, "0").replace(/0+$/, "");
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  return sign + (units / scale) + (tail ? "." + tail : "");
}

function macroValue(tag: NbtTag): string {
  switch (tag.type) {
    case "float": return macroDecimal(Math.fround(tag.value));
    case "double": return macroDecimal(tag.value);
    case "string": return tag.value;
    case "byte": case "short": case "int": case "long": return String(tag.value);
    default: return compoundSnbt(tag);
  }
}

export type MacroExpansion = { ok: true; ir: CommandIR } | { ok: false; reason: string };

/** Read each changed argument in isolation. A value cannot spill into a neighboring node. */
export function expandMacro(ir: CommandIR, input: NbtCompound | undefined): MacroExpansion {
  const template = ir.macro;
  if (!template) return {ok: true, ir};
  const edits = new Map<number, { end: number; text: string; value: ArgumentValue }>();
  let source = "";
  let cursor = 0;
  for (const argument of template.arguments) {
    let text = "";
    for (const part of argument.parts) {
      if (typeof part === "string") { text += part; continue; }
      const tag = input?.value.get(part.key);
      if (!tag) return {ok: false, reason: `missing macro argument '${part.key}'`};
      text += macroValue(tag);
    }
    try {
      const reader = new StringReader(text);
      const value = ARGUMENT_PARSERS[argument.parser]!(reader, argument.properties, template);
      if (!text.trim() || reader.canRead() || (argument.parser === "minecraft:score_holder" && value.kind === "selector")) {
        return {ok: false, reason: `macro value changes argument boundaries or requires an ID mapping (${argument.parser})`};
      }
      edits.set(argument.start, {end: argument.end, text, value});
    } catch (error) {
      if (!(error instanceof CommandSyntaxError)) throw error;
      return {ok: false, reason: `invalid macro argument (${argument.parser}): ${error.message}`};
    }
    source += ir.source.slice(cursor, argument.start) + text;
    cursor = argument.end;
  }
  source += ir.source.slice(cursor);
  const move = (position: number) => {
    let offset = 0;
    for (const [start, edit] of edits) {
      if (edit.end > position) break;
      offset += edit.text.length - (edit.end - start);
    }
    return position + offset;
  };
  const nodes = (list: ParsedNode[]) => list.map(node => {
    const edit = edits.get(node.start);
    return {...node, start: move(node.start), end: move(node.end), ...(edit && {value: edit.value})};
  });
  const bind = ({context, command}: CommandIR): CommandIR => ({
    source,
    context: context.map(step => ({...step, nodes: nodes(step.nodes)})),
    ...(command && {command: {...command, nodes: nodes(command.nodes), ...(command.run && {run: bind(command.run)})}}),
  });
  const normalized = normalizeCommandIR(bind(ir), template.version);
  return normalized.ok ? normalized : {ok: false, reason: normalized.reason};
}
