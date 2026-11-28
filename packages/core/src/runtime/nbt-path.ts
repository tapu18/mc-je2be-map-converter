import type { NbtPathNode } from "../command/arguments.ts";
import type { NbtTag } from "../nbt/nbt.ts";

/** Java compound predicates match a subset recursively. */
export function matchesNbt(value: NbtTag, pattern: NbtTag): boolean {
  if (value.type !== pattern.type) return false;
  if (pattern.type === "compound" && value.type === "compound") {
    return [...pattern.value].every(([key, tag]) => {
      const child = value.value.get(key);
      return child !== undefined && matchesNbt(child, tag);
    });
  }
  if (pattern.type === "list" && value.type === "list") {
    return pattern.value.length === 0 ? value.value.length === 0 : pattern.value.every(p => value.value.some(v => matchesNbt(v, p)));
  }
  if (pattern.type === "byteArray" || pattern.type === "intArray" || pattern.type === "longArray") {
    const a = value.value as Int8Array | Int32Array | BigInt64Array;
    return pattern.value.length === a.length && pattern.value.every((v, i) => v === a[i]);
  }
  return value.value === pattern.value;
}

/** Resolve all existing values in a parsed NBT path, preserving list order. */
export function getNbtPath(root: NbtTag, path: readonly NbtPathNode[]): NbtTag[] {
  let current = [root];
  for (const node of path) {
    const next: NbtTag[] = [];
    for (const tag of current) {
      if (node.kind === "key" && tag.type === "compound") {
        const child = tag.value.get(node.key);
        if (child !== undefined) next.push(child);
      } else if (node.kind === "index" && tag.type === "list") {
        const child = tag.value.at(node.index);
        if (child !== undefined) next.push(child);
      } else if (node.kind === "index" && (tag.type === "byteArray" || tag.type === "intArray" || tag.type === "longArray")) {
        // Java indexes numeric arrays like lists (e.g. UUID[0]).
        const child = tag.value.at(node.index);
        if (typeof child === "bigint") next.push({type: "long", value: child});
        else if (child !== undefined) next.push({type: tag.type === "byteArray" ? "byte" : "int", value: child});
      } else if (node.kind === "all" && tag.type === "list") next.push(...tag.value);
      else if (node.kind === "filter") {
        if (tag.type === "list") next.push(...tag.value.filter(child => matchesNbt(child, node.filter)));
        else if (matchesNbt(tag, node.filter)) next.push(tag);
      }
    }
    current = next;
  }
  return current;
}
