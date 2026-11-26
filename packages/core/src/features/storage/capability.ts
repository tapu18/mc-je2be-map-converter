import type { CapabilityInput, CapabilityResult } from "../capability.ts";
import { invalidCapability } from "../capability.ts";

/** The storage runtime accepts storage sources and the implemented mutation forms. */
export function assessStorage(input: CapabilityInput): CapabilityResult {
  if (input.status === "invalid") return invalidCapability(input);
  const command = input.ir.command, nodes = command?.nodes ?? [];
  const arg = (name: string) => nodes.find(n => n.kind === "argument" && n.name === name)?.value;
  const op = nodes[0]?.name, nbt = arg("nbt");
  let supported = command?.name === "data" && nodes[1]?.name === "storage" && arg("target")?.kind === "resource";
  if (supported && op === "get") supported = true;
  else if (supported && op === "merge") supported = nbt?.kind === "nbt" && nbt.value.type === "compound";
  else if (supported && op === "remove") supported = arg("path")?.kind === "nbtPath";
  else if (supported && op === "modify") {
    const operation = nodes[4]?.name;
    const source = nodes.findIndex(n => n.name === "from" || n.name === "string");
    supported = arg("targetPath")?.kind === "nbtPath" && ["set", "merge", "insert", "prepend", "append"].includes(operation ?? "") &&
      (operation !== "insert" || arg("index")?.kind === "number") &&
      (arg("value")?.kind === "nbt" || (source >= 0 && nodes[source + 1]?.name === "storage" && arg("source")?.kind === "resource" && (nodes[source]?.name !== "string" || arg("sourcePath")?.kind === "nbtPath")));
  } else supported = false;
  return { status: supported ? "runtime" : "unsupported", reason: supported ? "storage runtime" : "unsupported storage form", warnings: [], requiredContext: [] };
}
