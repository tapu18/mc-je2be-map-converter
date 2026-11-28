// kill・tag・teleport（tp）の書き換え（#346）。BE との違いは scenarios/convert/entity-commands で実測する。
import type { ParsedNode } from "../../command/parser.ts";

interface EntityEditor {
  replace(start: number, end: number, text: string): void;
  unsupported(message: string): void;
}

const arg = (nodes: ParsedNode[], name: string): ParsedNode | undefined => nodes.find((n) => n.kind === "argument" && n.name === name);

/** kill は BE でも同じ形で書ける */
export function rewriteKill(_nodes: ParsedNode[], _ed: EntityEditor): void {}

/** tag の add・remove・list は BE でも同じ形で書ける */
export function rewriteTag(_nodes: ParsedNode[], _ed: EntityEditor): void {}

/**
 * teleport・tp。BE の facing は `facing <対象>` で、Java の `facing entity <対象> [feet|eyes]` の entity と feet を除く。
 * BE は常に目の高さを向くため eyes だけは変換できない
 */
export function rewriteTeleport(nodes: ParsedNode[], ed: EntityEditor): void {
  const target = arg(nodes, "facingEntity");
  if (!target) return;
  const anchor = arg(nodes, "facingAnchor");
  if (anchor?.value?.kind === "word" && anchor.value.value === "eyes") {
    return ed.unsupported("tp の facing entity eyes は BE の tp にない");
  }
  const entity = nodes[nodes.indexOf(target) - 1]!;
  const facing = nodes[nodes.indexOf(entity) - 1]!;
  ed.replace(facing.end, entity.end, "");
  if (anchor) ed.replace(target.end, anchor.end, "");
}
