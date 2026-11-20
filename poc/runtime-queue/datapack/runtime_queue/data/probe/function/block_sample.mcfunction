data modify storage probe:trace events append value {event:"cb"}
execute store result storage probe:trace events[-1].tick int 1 run time query gametime
execute store result storage probe:trace events[-1].seen int 1 run scoreboard players get fn_value rt
scoreboard players add cb_count rt 1
scoreboard players operation cb_value rt = cb_count rt
execute store result storage probe:trace events[-1].wrote int 1 run scoreboard players get cb_value rt
