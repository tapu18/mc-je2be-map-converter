// BDS 1.26.63.1 のコマンド引数で受理された ID（rewrite.servers.test.ts）。
const ENTITY_TYPES = new Set(`
  allay area_effect_cloud armadillo armor_stand arrow axolotl bat bee blaze boat bogged breeze camel
  camel_husk cat cave_spider chest_boat chest_minecart chicken cod command_block_minecart copper_golem cow
  creaking creeper cushion dolphin donkey dragon_fireball drowned egg elder_guardian ender_dragon
  ender_pearl enderman endermite falling_block fireball fox frog ghast glow_squid goat guardian
  happy_ghast hoglin hopper_minecart horse husk iron_golem item leash_knot lightning_bolt
  lingering_potion llama llama_spit magma_cube minecart mooshroom mule nautilus ocelot
  ominous_item_spawner painting panda parched parrot phantom pig piglin piglin_brute pillager player
  polar_bear pufferfish rabbit ravager salmon sheep shulker shulker_bullet silverfish skeleton
  skeleton_horse slime small_fireball sniffer snow_golem snowball spider splash_potion squid stray
  strider sulfur_cube tadpole tnt tnt_minecart trader_llama turtle vex villager vindicator wandering_trader
  warden witch wither wither_skeleton wither_skull wolf zoglin zombie zombie_horse zombie_nautilus zombie_villager
`.trim().split(/\s+/));

const ENTITY_ALIASES = new Map([
  ["breeze_wind_charge", "breeze_wind_charge_projectile"],
  ["end_crystal", "ender_crystal"],
  ["evoker", "evocation_illager"],
  ["evoker_fangs", "evocation_fang"],
  ["experience_bottle", "xp_bottle"],
  ["experience_orb", "xp_orb"],
  ["eye_of_ender", "eye_of_ender_signal"],
  ["firework_rocket", "fireworks_rocket"],
  ["fishing_bobber", "fishing_hook"],
  ["trident", "thrown_trident"],
  ["tropical_fish", "tropicalfish"],
  ["wind_charge", "wind_charge_projectile"],
  ["zombified_piglin", "zombie_pigman"],
]);

const EFFECTS = new Set(`
  absorption bad_omen blindness breath_of_the_nautilus conduit_power darkness fire_resistance haste
  health_boost hunger infested instant_damage instant_health invisibility jump_boost levitation
  mining_fatigue nausea night_vision oozing poison raid_omen regeneration resistance saturation
  slow_falling slowness speed strength trial_omen water_breathing weakness weaving wind_charged wither
`.trim().split(/\s+/));

export function bedrockEntityType(javaId: string): string | undefined {
  if (!javaId.startsWith("minecraft:")) return undefined;
  const id = javaId.slice("minecraft:".length);
  return ENTITY_ALIASES.get(id) ?? (ENTITY_TYPES.has(id) ? id : undefined);
}

export function bedrockEffect(javaId: string): string | undefined {
  if (!javaId.startsWith("minecraft:")) return undefined;
  const id = javaId.slice("minecraft:".length);
  if (id === "hero_of_the_village") return "village_hero";
  return EFFECTS.has(id) ? id : undefined;
}
