import { normalize1_20_5ItemsAndText } from "./normalize-1-20-5.ts";
import { normalize1_21Attribute } from "./normalize-1-21.ts";
import { normalize1_21_2Arguments } from "./normalize-1-21-2.ts";
import { normalize1_21_4CustomModelData } from "./normalize-1-21-4.ts";
import { normalize1_21_9SpawnRotation } from "./normalize-1-21-9.ts";
import { normalize1_21_11Worldborder } from "./normalize-1-21-11.ts";
import { normalize26_1Time } from "./normalize-26-1.ts";
import { normalize26_2TeamColor } from "./normalize-26-2.ts";
import { normalize26_3DataArgumentNames } from "./normalize-26-3.ts";
import { normalize26_3Schedule } from "./normalize-schedule-26-3.ts";
import type { CommandIR } from "./parser.ts";

export type CommandNormalization = { ok: true; ir: CommandIR } | { ok: false; reason: string; start: number; end: number };

/** 各境界の直前のリリースと、その境界を越えたリリース。差分がある境界だけを並べる。 */
const boundaries: readonly {
  from: string;
  to: string;
  apply: (ir: CommandIR) => CommandIR | CommandNormalization;
}[] = [
  { from: "1.20.4", to: "1.20.5", apply: normalize1_20_5ItemsAndText },
  { from: "1.20.6", to: "1.21", apply: normalize1_21Attribute },
  { from: "1.21.1", to: "1.21.2", apply: normalize1_21_2Arguments },
  { from: "1.21.3", to: "1.21.4", apply: normalize1_21_4CustomModelData },
  { from: "1.21.8", to: "1.21.9", apply: normalize1_21_9SpawnRotation },
  { from: "1.21.10", to: "1.21.11", apply: normalize1_21_11Worldborder },
  { from: "1.21.11", to: "26.1", apply: normalize26_1Time },
  { from: "26.1", to: "26.2", apply: normalize26_2TeamColor },
  { from: "26.2", to: "26.3", apply: ir => normalize26_3Schedule(normalize26_3DataArgumentNames(ir)) },
];

export function isEarlierJavaRelease(version: string, boundary: string): boolean {
  const parts = version.split(".").map(Number);
  const target = boundary.split(".").map(Number);
  for (let index = 0; index < Math.max(parts.length, target.length); index++) {
    const part = parts[index] ?? 0;
    const other = target[index] ?? 0;
    if (part !== other) return part < other;
  }
  return false;
}

/** 元の版でパースした IR に、26.3 までの境界を順に適用する。位置と source は元の入力を指す。 */
export function normalizeCommandIR(ir: CommandIR, sourceVersion: string): CommandNormalization {
  for (const { from, to, apply } of boundaries) {
    if (!isEarlierJavaRelease(sourceVersion, to)) continue;
    const result = apply(ir);
    if ("ok" in result) {
      if (!result.ok) return { ...result, reason: `${from} → ${to}: ${result.reason}` };
      ir = result.ir;
    } else {
      ir = result;
    }
  }
  return { ok: true, ir };
}
