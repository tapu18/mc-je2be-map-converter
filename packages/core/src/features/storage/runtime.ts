import type { NbtPathNode } from "../../command/arguments.ts";
import type { CommandIR, ParsedNode } from "../../command/parser.ts";
import type { NbtCompound, NbtTag } from "../../nbt/nbt.ts";
import type { ExecutionResult } from "../../runtime/index.ts";
import { copyNbt, insertNbtPath, mergeNbt, removeNbtPath, setNbtPath } from "../../runtime/nbt-mutation.ts";
import { getNbtPath } from "../../runtime/nbt-path.ts";

const fail = (error: string): ExecutionResult => ({success: false, error});
const result = (count: number): ExecutionResult => count ? {success: true, result: count} : fail("nothing changed");
const argument = (nodes: ParsedNode[], name: string) => nodes.find(n => n.kind === "argument" && n.name === name)?.value;
const resource = (nodes: ParsedNode[], name: string): string | undefined => { const v = argument(nodes, name); return v?.kind === "resource" ? v.id : undefined; };
const path = (nodes: ParsedNode[], name: string): NbtPathNode[] | undefined => { const v = argument(nodes, name); return v?.kind === "nbtPath" ? v.path : undefined; };
const number = (nodes: ParsedNode[], name: string): number | undefined => { const v = argument(nodes, name); return v?.kind === "number" ? v.value : undefined; };
const value = (nodes: ParsedNode[], name: string): NbtTag | undefined => { const v = argument(nodes, name); return v?.kind === "nbt" ? v.value : undefined; };

/** Runtime-owned storage state; missing storage reads as an empty compound. */
export class StorageState {
  readonly values = new Map<string, NbtCompound>();
  get(id: string): NbtCompound { return this.values.get(id) ?? {type: "compound", value: new Map()}; }
  writable(id: string): NbtCompound { let v = this.values.get(id); if (!v) { v = {type: "compound", value: new Map()}; this.values.set(id, v); } return v; }
}

/** The result of `data get` for one selected tag: a floored numeric value, or the size of a compound, list, array or string. */
export function dataGetResult(tag: NbtTag, scale?: number): ExecutionResult {
  if (scale !== undefined && typeof tag.value !== "number" && typeof tag.value !== "bigint") return fail("scaled data must be numeric");
  let n: number;
  if (typeof tag.value === "number" || typeof tag.value === "bigint") n = Number(tag.value);
  else if (tag.type === "compound") n = tag.value.size;
  else n = tag.value.length;
  return {success: true, result: Math.floor(n * (scale ?? 1))};
}

/** Execute supported storage commands, rejecting other sources and operations. */
export function executeStorageCommand(storage: StorageState, command: NonNullable<CommandIR["command"]>): ExecutionResult {
  const nodes = command.nodes;
  if (command.name !== "data" || nodes[1]?.name !== "storage") return fail("unsupported data source");
  const id = resource(nodes, "target");
  if (!id) return fail("missing storage target");
  const op = nodes[0]?.name;
  if (op === "get") {
    const p = path(nodes, "path"); const matches = p ? getNbtPath(storage.get(id), p) : [storage.get(id)];
    if (matches.length !== 1) return fail("expected one value");
    return dataGetResult(matches[0]!, number(nodes, "scale"));
  }
  if (op === "merge") {
    const nbt = value(nodes, "nbt");
    return nbt?.type === "compound" ? result(mergeNbt(storage.writable(id), nbt) ? 1 : 0) : fail("invalid merge value");
  }
  if (op === "remove") { const p = path(nodes, "path"); return p ? result(removeNbtPath(storage.get(id), p)) : fail("missing path"); }
  if (op !== "modify") return fail("unsupported storage operation");
  const targetPath = path(nodes, "targetPath");
  if (!targetPath) return fail("missing target path");
  const operation = nodes[4]?.name;
  const direct = value(nodes, "value");
  const sourceId = resource(nodes, "source");
  const sourcePath = path(nodes, "sourcePath");
  let values: NbtTag[];
  if (direct) values = [direct];
  else if (sourceId && sourcePath && nodes.some((n, i) => n.name === "string" && nodes[i + 1]?.name === "storage")) {
    const source = getNbtPath(storage.get(sourceId), sourcePath);
    if (source.some(v => v.type !== "string")) return fail("unsupported non-string substring source");
    values = [];
    for (const tag of source) {
      if (tag.type !== "string") continue;
      const length = tag.value.length;
      const startArg = number(nodes, "start") ?? 0, endArg = number(nodes, "end") ?? length;
      const start = startArg < 0 ? length + startArg : startArg;
      const end = endArg < 0 ? length + endArg : endArg;
      if (start < 0 || end > length || start > end) return fail("substring bounds");
      values.push({type: "string", value: tag.value.slice(start, end)});
    }
  }
  else if (sourceId && nodes.some(n => n.name === "from") && nodes.some((n, i) => n.name === "from" && nodes[i + 1]?.name === "storage")) values = sourcePath ? getNbtPath(storage.get(sourceId), sourcePath).map(copyNbt) : [copyNbt(storage.get(sourceId))];
  else return fail("unsupported storage value source");
  if (!values.length) return fail("source path missing");
  const root = storage.writable(id);
  if (operation === "set") return result(setNbtPath(root, targetPath, values[values.length - 1]!));
  if (operation === "merge") {
    if (!values.every(v => v.type === "compound")) return fail("merge values must be compounds");
    if (!getNbtPath(root, targetPath).length) setNbtPath(root, targetPath, {type: "compound", value: new Map()});
    let count = 0;
    for (const target of getNbtPath(root, targetPath)) {
      if (target.type !== "compound") continue;
      let changed = false;
      for (const v of values) if (v.type === "compound" && mergeNbt(target, v)) changed = true;
      if (changed) count++;
    }
    return result(count);
  }
  if (operation === "insert" || operation === "prepend" || operation === "append") {
    const index = operation === "prepend" ? 0 : operation === "append" ? -1 : number(nodes, "index");
    if (index === undefined) return fail("missing index");
    if (!getNbtPath(root, targetPath).length) setNbtPath(root, targetPath, {type: "list", elementType: "end", value: []});
    return result(insertNbtPath(root, targetPath, index, values));
  }
  return fail("unsupported storage modification");
}
