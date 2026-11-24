import type { CommandIR } from "../../command/parser.ts";
import { assessSound } from "./capability.ts";

interface SoundEditor {
  replace(start: number, end: number, text: string): void;
  unsupported(message: string): void;
  warn(message: string): void;
}

export function rewriteSound(ir: CommandIR, soundMapping: (id: string) => string | undefined, ed: SoundEditor): void {
  const result = assessSound({ status: "parsed", ir }, soundMapping);
  if (result.status !== "native") return ed.unsupported(result.reason);
  const { id, sound, category, targets, hasPosition } = result.value;
  ed.replace(sound.start, category?.end ?? sound.end, targets ? id : `${id} @s ~ ~ ~`);
  if (targets && !hasPosition) ed.replace(targets.end, targets.end, " ~ ~ ~");
  for (const warning of result.warnings) ed.warn(warning);
}
