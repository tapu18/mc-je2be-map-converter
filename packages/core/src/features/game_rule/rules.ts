// Java 1.21.10 / 26.3 commands.json と BDS 1.26.66.1 の gamerule 実測（#318）。
type JavaType = "bool" | "integer";

type BedrockRule =
  | { name: string; type: "bool" }
  | { name: string; type: "integer"; min: number; max: number }
  | { name: string; type: "waypoints" };

interface GameRule {
  legacy: string;
  javaType: JavaType;
  bedrock?: BedrockRule;
  difference?: string;
}

function bool(legacy: string, name = legacy): GameRule {
  return { legacy, javaType: "bool", bedrock: { name, type: "bool" } };
}

function integer(legacy: string, min: number, max: number): GameRule {
  return { legacy, javaType: "integer", bedrock: { name: legacy, type: "integer", min, max } };
}

function unsupported(legacy: string, javaType: JavaType, difference?: string): GameRule {
  return { legacy, javaType, ...(difference ? { difference } : {}) };
}

export const gameRules: ReadonlyMap<string, GameRule> = new Map([
  ["advance_time", bool("doDaylightCycle")],
  ["advance_weather", bool("doWeatherCycle")],
  ["allow_entering_nether_using_portals", unsupported("allowEnteringNetherUsingPortals", "bool")],
  ["block_drops", bool("doTileDrops")],
  ["block_explosion_drop_decay", unsupported("blockExplosionDropDecay", "bool")],
  ["command_block_output", bool("commandBlockOutput")],
  ["command_blocks_work", bool("commandBlocksEnabled")],
  ["drowning_damage", bool("drowningDamage")],
  ["elytra_movement_check", unsupported("disableElytraMovementCheck", "bool")],
  ["ender_pearls_vanish_on_death", unsupported("enderPearlsVanishOnDeath", "bool")],
  ["entity_drops", bool("doEntityDrops")],
  ["fall_damage", bool("fallDamage")],
  ["fire_damage", bool("fireDamage")],
  ["fire_spread_radius_around_player", unsupported("allowFireTicksAwayFromPlayer", "integer",
    "Java の火の延焼距離に対応する設定が BE にない（BE が設定できるのは延焼のオン・オフ）")],
  ["forgive_dead_players", unsupported("forgiveDeadPlayers", "bool")],
  ["freeze_damage", bool("freezeDamage")],
  ["global_sound_events", unsupported("globalSoundEvents", "bool")],
  ["immediate_respawn", bool("doImmediateRespawn")],
  ["keep_inventory", bool("keepInventory")],
  ["lava_source_conversion", unsupported("lavaSourceConversion", "bool")],
  ["limited_crafting", bool("doLimitedCrafting")],
  ["locator_bar", { legacy: "locatorBar", javaType: "bool", bedrock: { name: "playerWaypoints", type: "waypoints" } }],
  ["log_admin_commands", unsupported("logAdminCommands", "bool")],
  ["max_block_modifications", unsupported("commandModificationBlockLimit", "integer")],
  ["max_command_forks", unsupported("maxCommandForkCount", "integer")],
  ["max_command_sequence_length", unsupported("maxCommandChainLength", "integer",
    "Java はコマンド実行系列ごとの処理数を制限するが、BE の maxCommandChainLength は tick ごとの連鎖コマンド数を制限する")],
  ["max_entity_cramming", unsupported("maxEntityCramming", "integer")],
  ["max_minecart_speed", unsupported("minecartMaxSpeed", "integer")],
  ["max_snow_accumulation_height", unsupported("snowAccumulationHeight", "integer")],
  ["mob_drops", bool("doMobLoot")],
  ["mob_explosion_drop_decay", unsupported("mobExplosionDropDecay", "bool")],
  ["mob_griefing", bool("mobGriefing")],
  ["natural_health_regeneration", bool("naturalRegeneration")],
  ["player_movement_check", unsupported("disablePlayerMovementCheck", "bool")],
  ["players_nether_portal_creative_delay", unsupported("playersNetherPortalCreativeDelay", "integer")],
  ["players_nether_portal_default_delay", unsupported("playersNetherPortalDefaultDelay", "integer")],
  ["players_sleeping_percentage", integer("playersSleepingPercentage", -2147483648, 2147483647)],
  ["projectiles_can_break_blocks", bool("projectilesCanBreakBlocks")],
  ["pvp", bool("pvp")],
  ["raids", unsupported("disableRaids", "bool")],
  ["random_tick_speed", integer("randomTickSpeed", 0, 4096)],
  ["reduced_debug_info", unsupported("reducedDebugInfo", "bool")],
  ["respawn_radius", integer("spawnRadius", 0, 128)],
  ["send_command_feedback", bool("sendCommandFeedback")],
  ["show_advancement_messages", unsupported("announceAdvancements", "bool",
    "Java の進捗通知に対応する設定が BE にない（BE のレシピ通知は別機能）")],
  ["show_death_messages", bool("showDeathMessages")],
  ["spawn_mobs", bool("doMobSpawning")],
  ["spawn_monsters", unsupported("spawnMonsters", "bool",
    "BE の設定はモブ全体に作用する。敵対モブだけに絞るルールが BE にない")],
  ["spawn_patrols", unsupported("doPatrolSpawning", "bool")],
  ["spawn_phantoms", bool("doInsomnia")],
  ["spawn_wandering_traders", unsupported("doTraderSpawning", "bool")],
  ["spawn_wardens", unsupported("doWardenSpawning", "bool")],
  ["spawner_blocks_work", unsupported("spawnerBlocksEnabled", "bool")],
  ["spectators_generate_chunks", unsupported("spectatorsGenerateChunks", "bool")],
  ["spread_vines", unsupported("doVinesSpread", "bool")],
  ["tnt_explodes", bool("tntExplodes")],
  ["tnt_explosion_drop_decay", bool("tntExplosionDropDecay")],
  ["universal_anger", unsupported("universalAnger", "bool")],
  ["water_source_conversion", unsupported("waterSourceConversion", "bool")],
]);

// 1.21.11 で 2 つの旧ルールが延焼距離に置き換わった。旧版のオン・オフは個別に変換する。
const legacyRules = new Map(Array.from(gameRules, ([id, rule]) => [rule.legacy, { id, rule }]));
legacyRules.set("allowFireTicksAwayFromPlayer", {
  id: "fire_spread_radius_around_player",
  rule: unsupported("allowFireTicksAwayFromPlayer", "bool",
    "BE にプレイヤーから離れた場所の延焼だけを切り替える設定がない"),
});
legacyRules.set("doFireTick", { id: "fire_spread_radius_around_player", rule: bool("doFireTick") });

export function gameRuleByJavaName(name: string): { id: string; rule: GameRule } | undefined {
  const id = name.startsWith("minecraft:") ? name.slice("minecraft:".length) : name;
  const rule = gameRules.get(id);
  return rule ? { id, rule } : legacyRules.get(name);
}
