import type { NbtPathNode } from "../../command/arguments.ts";
import { nbt, type NbtTag } from "../../nbt/nbt.ts";
import type { ExecutionHost, RuntimeEntity } from "../../runtime/context.ts";
import { getNbtPath } from "../../runtime/nbt-path.ts";

/**
 * Virtual NBT layer (design.md 5.7, #345): Java entity NBT assembled from host values instead of a saved compound.
 * Only these top-level keys are readable, each optionally followed by one list or array index.
 */
export const virtualEntityKeys = ["Pos", "Rotation", "Motion", "UUID"] as const;
type VirtualKey = typeof virtualEntityKeys[number];

export type VirtualRead = {ok: true; value: NbtTag} | {ok: false; error: string};

/** Why a path is outside the virtual layer, or undefined when it can be read. `text` is the path as written. */
export function unsupportedEntityPath(path: readonly NbtPathNode[] | undefined, text = ""): string | undefined {
  if (!path) return "reading an entity's whole NBT is not supported";
  const [first, second, ...rest] = path;
  if (first?.kind !== "key" || !(virtualEntityKeys as readonly string[]).includes(first.key) || rest.length || (second && second.kind !== "index")) {
    return `entity NBT path ${text || "(unnamed)"} is not supported; readable paths are ${virtualEntityKeys.map(key => `${key}, ${key}[n]`).join(", ")}`;
  }
}

function rootValue(host: ExecutionHost | undefined, entity: RuntimeEntity, key: VirtualKey): VirtualRead {
  switch (key) {
    case "Pos": return {ok: true, value: nbt.list("double", entity.position.map(nbt.double))};
    // Java stores rotations as floats; scaled reads see the float's exact value (12.7f * 10 floors to 126).
    // -0 becomes 0: Java's float tags compare them as equal and the recorded JSON cannot tell them apart.
    case "Rotation": return {ok: true, value: nbt.list("float", entity.rotation.map(angle => nbt.float(Math.fround(angle) || 0)))};
    case "Motion": {
      const motion = host?.entityMotion?.(entity.id);
      return motion ? {ok: true, value: nbt.list("double", motion.map(nbt.double))} : {ok: false, error: "unsupported entity NBT: Motion is unavailable from the host"};
    }
    case "UUID": {
      const uuid = host?.entityUuid?.(entity.id);
      return uuid ? {ok: true, value: {type: "intArray", value: Int32Array.from(uuid)}} : {ok: false, error: "unsupported entity NBT: the host holds no Java UUID for the entity"};
    }
  }
}

/** Read one supported path (checked with `unsupportedEntityPath`) from a selected entity. */
export function readVirtualEntityPath(host: ExecutionHost | undefined, entity: RuntimeEntity, path: readonly NbtPathNode[]): VirtualRead {
  const [first, ...rest] = path;
  if (first?.kind !== "key" || !(virtualEntityKeys as readonly string[]).includes(first.key)) return {ok: false, error: "unsupported entity NBT path"};
  const root = rootValue(host, entity, first.key as VirtualKey);
  if (!root.ok) return root;
  const [value] = getNbtPath(root.value, rest);
  return value ? {ok: true, value} : {ok: false, error: "no elements match the path"};
}
