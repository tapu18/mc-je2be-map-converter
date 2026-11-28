import type { CommandIR, ParsedNode } from "../../command/parser.ts";
import type { CapabilityInput, CapabilityResult } from "../capability.ts";
import { invalidCapability } from "../capability.ts";
import { entityTarget } from "../../runtime/context.ts";
import { unsupportedEntityPath } from "./virtual.ts";

/** Where an entity is read in a `data` command: the target of `data get entity`, or the `from entity` source of a storage modification. */
export interface EntityNbtRead { kind: "get" | "storage"; target: ParsedNode; path?: ParsedNode; sourceIndex: number }

export type EntityNbtForm = {status: "runtime"; read: EntityNbtRead} | {status: "unsupported"; reason: string};

const modifications = ["set", "merge", "insert", "prepend", "append"];
const text = (ir: CommandIR, node?: ParsedNode) => node ? ir.source.slice(node.start, node.end) : "";

/** Classify `data` commands that touch entity NBT; undefined when no entity is involved. */
export function entityNbtForm(ir: CommandIR): EntityNbtForm | undefined {
  const command = ir.command;
  if (command?.name !== "data") return;
  const nodes = command.nodes;
  const op = nodes[0]?.name ?? "";
  const unsupported = (reason: string): EntityNbtForm => ({status: "unsupported", reason});
  const readable = (kind: EntityNbtRead["kind"], target: ParsedNode | undefined, path: ParsedNode | undefined, sourceIndex: number): EntityNbtForm => {
    if (!target || !entityTarget(target.value)) return unsupported(`entity selector ${text(ir, target)} is not supported`);
    const reason = unsupportedEntityPath(path?.value?.kind === "nbtPath" ? path.value.path : undefined, text(ir, path));
    return reason ? unsupported(reason) : {status: "runtime", read: {kind, target, ...(path ? {path} : {}), sourceIndex}};
  };
  if (nodes[1]?.name === "entity") {
    // Writes need the runtime-held values and host writes; they are later children of #182.
    if (op !== "get") return unsupported(`writing entity NBT (data ${op} entity) is not supported`);
    return readable("get", nodes[2], nodes[3], 2);
  }
  const source = nodes.findIndex((node, index) => (node.name === "from" || node.name === "string") && nodes[index + 1]?.name === "entity");
  if (source < 0) return;
  if (nodes[source]!.name === "string") return unsupported("data modify ... string entity is not supported");
  if (op !== "modify" || nodes[1]?.name !== "storage") return unsupported(`copying entity NBT into data ${op} ${nodes[1]?.name ?? ""} is not supported`);
  const operation = nodes[4]?.name ?? "";
  if (!modifications.includes(operation) || nodes[3]?.value?.kind !== "nbtPath" || nodes[2]?.value?.kind !== "resource"
    || (operation === "insert" && nodes[5]?.value?.kind !== "number")) return unsupported(`data modify storage ... ${operation} from entity is not supported`);
  return readable("storage", nodes[source + 2], nodes[source + 3], source);
}

export function assessEntityNbt(input: CapabilityInput): CapabilityResult {
  if (input.status === "invalid") return invalidCapability(input);
  const form = entityNbtForm(input.ir);
  if (form?.status === "runtime") return {status: "runtime", reason: "virtual entity NBT", warnings: [], requiredContext: []};
  return {status: "unsupported", reason: form?.reason ?? "not an entity NBT command", warnings: [], requiredContext: []};
}
