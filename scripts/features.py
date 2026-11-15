"""Java専用機能の検出パターン（正規表現による粗い判定）。

extract / analyze / datapack_features から共通で使う。
ヒットしない＝BEでそのまま動く、ではない（tellrawのJSON、ブロックステート、サウンドID等は別途変換が必要）。
"""
import re

JAVA_ONLY = [
    (r"\bdata (get|merge|modify|remove)\b", "data"),
    (r"\bstorage\b", "storage"),
    (r"nbt=", "nbt-selector"),
    (r"advancements=", "advancements-selector"),
    (r"\bpredicate\b", "predicate"),
    (r"\bstore (result|success)\b", "execute store"),
    (r"\b(if|unless) (data|function|items)\b", "if data/function/items"),
    (r"^/?team\b|\brun team\b", "team"),
    (r"\bbossbar\b", "bossbar"),
    (r"\btrigger\b", "trigger"),
    (r"\bschedule\b", "schedule"),
    (r"\bitem (replace|modify)\b", "item"),
    (r"\battribute\b", "attribute"),
    (r"\breturn\b", "return"),
    (r"click_?[eE]vent|hover_?[eE]vent", "click/hover"),
    (r"_display\b|\bmarker\b|\binteraction\b", "display/marker/interaction"),
    (r"\bdamage\b", "damage"),
    (r"\bforceload\b", "forceload"),
    (r"\bon (passengers|vehicle|attacker|owner|target|controller|origin|leasher)\b", "execute on"),
    (r"\bsummon\b[^{]*\{", "summon with NBT"),
    (r"\b(setblock|fill)\b[^{]*\{", "block NBT"),
    (r"\bgive\b.*\[", "item components"),
    (r"\bloot\b", "loot"),
    (r"\$\(", "macro"),
    (r"\bfunction \S+ (\{|with )", "macro call"),
    (r"\bscoreboard players operation\b.*(%=|/=)", "div/mod"),
    (r"\brandom\b", "random"),
]
_COMPILED = [(re.compile(p), n) for p, n in JAVA_ONLY]


def java_only_features(cmd):
    """コマンド1行に含まれるJava専用機能名のリスト（重複なし）。"""
    return [n for p, n in _COMPILED if p.search(cmd)]


def classify_command(cmd):
    """(kind, features, head) を返す。kind: empty / function-call / java-only / maybe-compatible"""
    c = cmd.strip().lstrip("/")
    feats = java_only_features(c)
    head = c.split(" ", 1)[0] if c else ""
    if not c:
        kind = "empty"
    elif head == "function" or re.match(r"^execute\b.*\brun function\b", c):
        kind = "function-call"
    else:
        kind = "java-only" if feats else "maybe-compatible"
    return kind, feats, head
