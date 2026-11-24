import type { TextFormat } from "./arguments.ts";
import type { CommandIR } from "./parser.ts";

/** Version 1 stores a tagged JSON tree, including all non-JSON JavaScript values. */
export interface IrDocument { grammarVersion: string; textFormat: TextFormat; ir: CommandIR }
export type IrDecodeResult = { ok: true; document: IrDocument } | { ok: false; diagnostic: string };

type Wire = null | boolean | number | string | Wire[];
function encode(v: unknown): Wire {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return Object.is(v, -0) ? ["number", "-0"] : v;
  }
  if (typeof v === "bigint") { long(v.toString()); return ["bigint", v.toString()]; }
  if (Array.isArray(v)) return ["array", ...v.map(encode)];
  if (v instanceof Map) return ["map", ...Array.from(v, ([k, x]) => [encode(k), encode(x)])];
  if (v instanceof Int8Array) return ["int8", ...v];
  if (v instanceof Int32Array) return ["int32", ...v];
  if (v instanceof BigInt64Array) return ["int64", ...Array.from(v, x => x.toString())];
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype)
    return ["object", ...Object.entries(v).map(([k, x]) => [k, encode(x)])];
  throw new Error("unsupported value");
}
function fail(): never { throw new Error("invalid encoded value"); }
function integer(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}
function long(v: unknown): bigint {
  if (typeof v !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(v)) return fail();
  const n = BigInt(v);
  if (n < -(1n << 63n) || n >= (1n << 63n)) return fail();
  return n;
}
function decode(v: unknown): unknown {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (!Array.isArray(v) || typeof v[0] !== "string") return fail();
  const [tag, ...values] = v;
  switch (tag) {
    case "number": if (values.length === 1 && values[0] === "-0") return -0; return fail();
    case "bigint": if (values.length === 1) return long(values[0]); return fail();
    case "array": return values.map(decode);
    case "int8": if (values.every(x => integer(x, -128, 127))) return Int8Array.from(values); return fail();
    case "int32": if (values.every(x => integer(x, -2147483648, 2147483647))) return Int32Array.from(values); return fail();
    case "int64": return BigInt64Array.from(values.map(long));
    case "object": case "map": {
      const entries: [string, unknown][] = [];
      const keys = new Set<string>();
      for (const pair of values) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || keys.has(pair[0])) return fail();
        keys.add(pair[0]); entries.push([pair[0], decode(pair[1])]);
      }
      return tag === "map" ? new Map(entries) : Object.fromEntries(entries);
    }
    default: return fail();
  }
}

// Structural schemas reject unknown variants and malformed values before handing IR to a runtime.
type Check = (v: unknown) => boolean;
const str: Check = v => typeof v === "string";
const num: Check = v => typeof v === "number" && Number.isFinite(v);
const bool: Check = v => typeof v === "boolean";
const arr = (c: Check): Check => v => Array.isArray(v) && v.every(c);
const one = (...cs: Check[]): Check => v => cs.some(c => c(v));
const lit = (...xs: string[]): Check => v => typeof v === "string" && xs.includes(v);
const obj = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => v => {
  if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return false;
  const o = v as Record<string, unknown>;
  return Object.entries(required).every(([k, c]) => Object.hasOwn(o, k) && c(o[k])) &&
    Object.entries(o).every(([k, x]) => Object.hasOwn(required, k) || (Object.hasOwn(optional, k) && optional[k]!(x)));
};
const record = (c: Check): Check => v => !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every(c);
const tagNames = ["byte", "short", "int", "long", "float", "double", "byteArray", "string", "list", "compound", "intArray", "longArray"];
const nbt: Check = v => one(
  obj({ type: lit("byte", "short", "int", "float", "double"), value: num }),
  obj({ type: lit("long"), value: x => typeof x === "bigint" }),
  obj({ type: lit("string"), value: str }),
  obj({ type: lit("byteArray"), value: x => x instanceof Int8Array }),
  obj({ type: lit("intArray"), value: x => x instanceof Int32Array }),
  obj({ type: lit("longArray"), value: x => x instanceof BigInt64Array }),
  obj({ type: lit("list"), elementType: lit("end", ...tagNames), value: arr(nbt) }),
  obj({ type: lit("compound"), value: x => x instanceof Map && Array.from(x).every(([k, t]) => str(k) && nbt(t)) }),
)(v);
const range = obj({}, { min: num, max: num });
const selectorValue: Check = one(
  obj({kind: lit("number"), value: num}), obj({kind: lit("range"), range}), obj({kind: lit("string"), value: str}),
  obj({kind: lit("resource"), id: str, tag: bool}), obj({kind: lit("nbt"), value: nbt}),
  obj({kind: lit("scores"), scores: record(range)}), obj({kind: lit("advancements"), advancements: record(one(bool, record(bool)))}),
);
const selector = obj({variable: str, arguments: arr(obj({key: str, negated: bool, value: selectorValue}))});
const value = one(
  obj({kind: lit("bool"), value: bool}), obj({kind: lit("number"), value: num}),
  obj({kind: lit("string", "name", "word"), value: str}), obj({kind: lit("selector"), selector}),
  obj({kind: lit("coordinates"), coordinates: arr(obj({kind: lit("absolute", "relative", "local"), value: num}))}),
  obj({kind: lit("block"), id: str, tag: bool, states: record(str)}, {nbt}),
  obj({kind: lit("item"), id: str, tag: bool, components: arr(obj({removed: bool, key: str}, {value: nbt}))}),
  obj({kind: lit("itemPredicate"), id: str, tag: bool, alternatives: arr(arr(obj({key: str, negated: bool}, {op: lit("=", "~"), value: nbt})))}),
  obj({kind: lit("nbt"), value: nbt}),
  obj({kind: lit("nbtPath"), path: arr(one(obj({kind: lit("key"), key: str}), obj({kind: lit("index"), index: num}), obj({kind: lit("all")}), obj({kind: lit("filter"), filter: nbt})))}),
  obj({kind: lit("text"), format: lit("json", "snbt"), value: nbt}), obj({kind: lit("resource"), id: str, tag: bool}),
  obj({kind: lit("particle"), id: str}, {options: nbt}), obj({kind: lit("range"), range}), obj({kind: lit("time"), ticks: num}),
);
const node = one(
  obj({kind: lit("literal"), name: str, start: num, end: num}, {jump: lit("execute", "root")}),
  obj({kind: lit("argument"), name: str, parser: str, start: num, end: num, value}, {jump: lit("execute", "root")}),
);
const irCheck = obj({source: str, context: arr(obj({kind: str, nodes: arr(node)}))}, {command: obj({name: str, nodes: arr(node)})});
const documentCheck = obj({grammarVersion: x => str(x) && x !== "", textFormat: lit("json", "snbt"), ir: irCheck});

export function serializeCommandIR(document: IrDocument): string {
  if (!documentCheck(document)) throw new Error("invalid IR document");
  return JSON.stringify({schemaVersion: 1, document: encode(document)});
}
export function deserializeCommandIR(json: string): IrDecodeResult {
  try {
    const envelope: unknown = JSON.parse(json);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("invalid envelope");
    const o = envelope as Record<string, unknown>;
    if (o.schemaVersion !== 1) throw new Error(`unsupported IR schema version: ${String(o.schemaVersion)}`);
    if (Object.keys(o).length !== 2 || !Object.hasOwn(o, "document")) throw new Error("invalid envelope");
    const document = decode(o.document);
    if (!documentCheck(document)) throw new Error("invalid IR document");
    return {ok: true, document: document as IrDocument};
  } catch (e) { return {ok: false, diagnostic: e instanceof Error ? e.message : "invalid IR"}; }
}
