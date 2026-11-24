import type { NbtPathNode } from "../command/arguments.ts";
import type { NbtTag } from "../nbt/nbt.ts";
import { getNbtPath, matchesNbt } from "./nbt-path.ts";

/** Copy a tag before inserting it into another location. */
export function copyNbt(tag: NbtTag): NbtTag {
  switch (tag.type) {
    case "compound": return { type: "compound", value: new Map([...tag.value].map(([key, value]) => [key, copyNbt(value)])) };
    case "list": return { ...tag, value: tag.value.map(copyNbt) };
    case "byteArray": return { ...tag, value: tag.value.slice() };
    case "intArray": return { ...tag, value: tag.value.slice() };
    case "longArray": return { ...tag, value: tag.value.slice() };
    default: return { ...tag };
  }
}

/** Exact equality, unlike the subset matching used for path predicates. */
function equalNbt(a: NbtTag, b: NbtTag): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "compound" && b.type === "compound") {
    return a.value.size === b.value.size && [...a.value].every(([key, value]) => {
      const other = b.value.get(key);
      return other !== undefined && equalNbt(value, other);
    });
  }
  if (a.type === "list" && b.type === "list") {
    return a.value.length === b.value.length && a.value.every((value, i) => equalNbt(value, b.value[i]!));
  }
  if ((a.type === "byteArray" && b.type === "byteArray") || (a.type === "intArray" && b.type === "intArray") || (a.type === "longArray" && b.type === "longArray")) {
    return a.value.length === b.value.length && a.value.every((value, i) => value === b.value[i]);
  }
  return a.value === b.value;
}

type Slot = { get(): NbtTag; set(value: NbtTag): void; remove(): void; created?: boolean };
function slots(parent: NbtTag, node: NbtPathNode, create: boolean, next?: NbtPathNode): Slot[] {
  if (node.kind === "key" && parent.type === "compound") {
    const created = !parent.value.has(node.key);
    if (created) {
      if (!create) return [];
      parent.value.set(node.key, next && (next.kind === "index" || next.kind === "all")
        ? { type: "list", elementType: "end", value: [] }
        : { type: "compound", value: new Map() });
    }
    return [{ created, get: () => parent.value.get(node.key)!, set: value => { parent.value.set(node.key, value); }, remove: () => { parent.value.delete(node.key); } }];
  }
  if (parent.type !== "list") return [];
  let indices: number[] = [];
  if (node.kind === "index") {
    const index = node.index < 0 ? parent.value.length + node.index : node.index;
    if (index >= 0 && index < parent.value.length) indices = [index];
  } else if (node.kind === "all") indices = parent.value.map((_, i) => i);
  else if (node.kind === "filter") indices = parent.value.flatMap((value, i) => matchesNbt(value, node.filter) ? [i] : []);
  return indices.map(index => ({
    get: () => parent.value[index]!,
    set: value => { if (value.type === parent.elementType) parent.value[index] = value; },
    remove: () => { parent.value.splice(index, 1); },
  }));
}

/** Assign to existing matches, creating missing compound keys along the way. */
export function setNbtPath(root: NbtTag, path: readonly NbtPathNode[], value: NbtTag): number {
  if (!path.length) return 0;
  let parents = [root];
  for (let i = 0; i < path.length - 1; i++) parents = parents.flatMap(parent => slots(parent, path[i]!, true, path[i + 1]).map(slot => slot.get()));
  const targets = parents.flatMap(parent => slots(parent, path[path.length - 1]!, true));
  let count = 0;
  for (const target of targets) {
    const before = target.get();
    if (target.created || !equalNbt(before, value)) {
      target.set(copyNbt(value));
      if (target.get() !== before) count++;
    }
  }
  return count;
}

/** Delete matches from right to left so list indices remain valid. */
export function removeNbtPath(root: NbtTag, path: readonly NbtPathNode[]): number {
  if (!path.length) return 0;
  let parents = [root];
  for (const node of path.slice(0, -1)) parents = parents.flatMap(parent => slots(parent, node, false).map(slot => slot.get()));
  const targets = parents.flatMap(parent => slots(parent, path[path.length - 1]!, false));
  for (const target of targets.reverse()) target.remove();
  return targets.length;
}

/** Insert copied values into each existing list selected by a path. */
export function insertNbtPath(root: NbtTag, path: readonly NbtPathNode[], index: number, values: readonly NbtTag[]): number {
  let count = 0;
  for (const target of getNbtPath(root, path)) {
    if (target.type !== "list") continue;
    let position = index < 0 ? target.value.length + index + 1 : index;
    if (position < 0 || position > target.value.length) continue;
    let changed = false;
    for (const value of values) {
      if (target.elementType !== "end" && target.elementType !== value.type) continue;
      target.elementType = value.type;
      target.value.splice(position++, 0, copyNbt(value));
      changed = true;
    }
    if (changed) count++;
  }
  return count;
}
