# 引数 s: 記録する名前。ゲーム時刻と一緒に storage poc:o list に追記する
execute store result storage poc:tmp t int 1 run time query gametime
$data modify storage poc:o list append value {s:"$(s)",t:0}
data modify storage poc:o list[-1].t set from storage poc:tmp t
