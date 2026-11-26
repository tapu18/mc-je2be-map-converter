import { bedrockEffect, parseSnbt } from "@je2be/core";
import type { BedrockServer } from "../bedrock.ts";
import type { JavaServer } from "../java.ts";
import type { ObservedEffect, ObservedEffects } from "./types.ts";

export async function observeBedrockEffects(bds: BedrockServer, probes: Record<string, string[]>): Promise<ObservedEffects> {
  const bedrockProbes = Object.fromEntries(Object.entries(probes).map(([tag, ids]) => [
    tag,
    Object.fromEntries(ids.map(id => [id, bedrockEffect(id) ?? id])),
  ]));
  const response = await bds.request<ObservedEffects>("entityEffects", { probes: bedrockProbes });
  if (!response.ok || !response.result) throw new Error(`bedrock effect observation failed: ${response.error ?? "no result"}`);
  return response.result;
}

export async function observeJavaEffects(java: JavaServer, probes: Record<string, string[]>, log: string[]): Promise<ObservedEffects> {
  const observations: ObservedEffects = {};
  for (const [tag, ids] of Object.entries(probes)) {
    const selector = `@e[tag=${tag},limit=1]`;
    const command = `data get entity ${selector} active_effects`;
    const response = await java.exec(command);
    log.push(`> ${command}\n${response}`);
    const effects = readJavaEffects(response);
    observations[tag] = Object.fromEntries(ids.map(id => [id, effects.get(id) ?? null]));
  }
  return observations;
}

function readJavaEffects(response: string): Map<string, ObservedEffect> {
  const effects = new Map<string, ObservedEffect>();
  if (response === "Found no elements matching active_effects") return effects;
  const payload = / has the following entity data: (\[.*\])$/.exec(response)?.[1];
  const list = payload && parseSnbt(payload);
  if (!list || list.type !== "list") throw new Error(`Invalid Java effect observation: ${response}`);
  for (const effect of list.value) {
    if (effect.type !== "compound") throw new Error(`Invalid Java effect: ${response}`);
    const id = effect.value.get("id");
    const duration = effect.value.get("duration");
    const amplifier = effect.value.get("amplifier");
    if (id?.type !== "string" || duration?.type !== "int" || (amplifier && amplifier.type !== "byte")) {
      throw new Error(`Invalid Java effect fields: ${response}`);
    }
    // Java は amplifier を unsigned byte として保存する。
    effects.set(id.value, { amplifier: (amplifier?.value ?? 0) & 0xff, duration: duration.value });
  }
  return effects;
}
