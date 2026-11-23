import type { NbtPathNode } from "../command/arguments.ts";
import type { NbtTag } from "../nbt/nbt.ts";
import { matchesNbt } from "./nbt-path.ts";

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

type Slot = { get(): NbtTag; set(value: NbtTag): void; remove(): void };
function slots(parent: NbtTag, node: NbtPathNode, create: boolean): Slot[] {
  if (node.kind === "key" && parent.type === "compound") {
    if (!parent.value.has(node.key)) {
      if (!create) return [];
      parent.value.set(node.key, { type: "compound", value: new Map() });
    }
    return [{ get: () => parent.value.get(node.key)!, set: value => { parent.value.set(node.key, value); }, remove: () => { parent.value.delete(node.key); } }];
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
  for (const node of path.slice(0, -1)) parents = parents.flatMap(parent => slots(parent, node, true).map(slot => slot.get()));
  const targets = parents.flatMap(parent => slots(parent, path[path.length - 1]!, true));
  let count = 0;
  for (const target of targets) {
    const before = target.get();
    target.set(copyNbt(value));
    if (target.get() !== before) count++;
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
