// BDS の effect コマンドで受理された ID（rewrite.servers.test.ts）。
const EFFECTS = new Set(`
  absorption bad_omen blindness breath_of_the_nautilus conduit_power darkness fire_resistance haste
  health_boost hunger infested instant_damage instant_health invisibility jump_boost levitation
  mining_fatigue nausea night_vision oozing poison raid_omen regeneration resistance saturation
  slow_falling slowness speed strength trial_omen water_breathing weakness weaving wind_charged wither
`.trim().split(/\s+/));

export function bedrockEffect(javaId: string): string | undefined {
  if (!javaId.startsWith("minecraft:")) return undefined;
  const id = javaId.slice("minecraft:".length);
  if (id === "hero_of_the_village") return "village_hero";
  return EFFECTS.has(id) ? id : undefined;
}
