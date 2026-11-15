#!/usr/bin/env python3
"""配布マップのコマンドを「型」に抽象化して頻度を数える（#45）。

検証用マップに何を詰め込むかを頻度で決めるための集計。作者が書いた部分（名前、タグ、数値、文章、NBT の中身）は
すべて伏せ、文法のキーワード・バニラの ID・記号（セレクタの引数のキー名、座標の形式）だけを残す。
出力にマップ名やコマンドの文面は含めない。

Usage:
    python3 -I scripts/command_patterns.py --reports <dir>/reports [--top 40] [--markdown] [sample-map ...]

<dir>/reports（commands.json と registries.json）は Java 版サーバーのデータ生成で作る（リポジトリには含めない）:
    java -DbundlerMainClass=net.minecraft.data.Main -jar servers/java-26.3/server.jar --reports --output <dir>
"""
import argparse, collections, io, json, re, sys, zipfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_command_blocks as ex
from analyze_chains import build_chains

COORD = re.compile(r"^([~^])?(-?\d+(\.\d+)?)?$")
# scoreboard players operation の演算子と、execute if score の比較（意味を左右するので伏せない）
OPERATORS = {"=", "+=", "-=", "*=", "/=", "%=", "<", ">", "><", "<=", ">="}
NUMBER = re.compile(r"^-?\d+(\.\d+)?[bsldf]?$|^-?\d*\.\.-?\d*$")


# 名前空間を省いた ID を、これらのレジストリと照合してバニラの ID として扱う
ID_REGISTRIES = ["minecraft:block", "minecraft:item", "minecraft:entity_type", "minecraft:sound_event", "minecraft:particle_type",
                 "minecraft:mob_effect", "minecraft:enchantment"]
VANILLA_IDS = set()


def load_registries(path):
    reg = json.load(open(path, encoding="utf-8"))
    for name in ID_REGISTRIES:
        for k in reg.get(name, {}).get("entries", {}):
            VANILLA_IDS.add(k.split(":", 1)[1])


def load_literals(path):
    tree = json.load(open(path, encoding="utf-8"))
    lits = set()

    def walk(n, depth=0):
        for k, c in n.get("children", {}).items():
            if c["type"] == "literal":
                lits.add(k)
            if depth < 40:
                walk(c, depth + 1)
    walk(tree)
    return lits, set(tree["children"])


def tokenize(cmd):
    """空白で区切る。ただし括弧と引用符の中の空白では区切らない"""
    toks, cur, depth, quote, esc = [], [], 0, None, False
    for ch in cmd:
        if quote:
            cur.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
        elif ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth = max(0, depth - 1)
        if ch == " " and depth == 0:
            if cur:
                toks.append("".join(cur)); cur = []
            continue
        cur.append(ch)
    if cur:
        toks.append("".join(cur))
    return toks


def selector_keys(tok):
    """@e[type=..,tag=..] → '@e[tag,type]'（値は伏せ、キーは重複を除いて並べる）"""
    head = tok[:2]
    if len(tok) <= 2 or tok[2] != "[":
        return head
    body = tok[3:-1] if tok.endswith("]") else tok[3:]
    keys, depth, cur = [], 0, []
    for ch in body + ",":
        if ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
        if ch == "," and depth == 0:
            k = "".join(cur).split("=", 1)[0].strip()
            if k:
                keys.append(k)
            cur = []
        else:
            cur.append(ch)
    return f"{head}[{','.join(sorted(set(keys)))}]"


def id_token(tok):
    """minecraft:stone[...]{...} → 'minecraft:stone[...]{nbt}'（[...] はブロックの状態またはアイテムのデータコンポーネント）。minecraft 以外の名前空間は伏せる"""
    m = re.match(r"^#?([a-z0-9_.\-]+):([a-z0-9_./\-]+)", tok)
    if not m:
        bare = re.match(r"^([a-z0-9_.]+)", tok)
        # 名前空間を省いたバニラの ID（stone、diamond_sword など）
        if bare and bare.group(1) in VANILLA_IDS and not tok.startswith("#"):
            rest = tok[bare.end():]
            if rest == "" or rest[0] in "[{":
                return f"minecraft:{bare.group(1)}" + ("[...]" if rest.startswith("[") else "") + ("{nbt}" if "{" in rest else "")
        return None
    rest = tok[m.end():]
    suffix = ("[...]" if rest.startswith("[") else "") + ("{nbt}" if "{" in rest else "")
    tag = "#" if tok.startswith("#") else ""
    if m.group(1) == "minecraft":
        return f"{tag}minecraft:{m.group(2)}{suffix}"
    return f"{tag}ns:ID{suffix}"


def abstract(cmd, literals):
    """コマンドを型の文字列にする。座標3つは POS(abs/rel/local/mixed) にまとめる"""
    out = []
    for tok in tokenize(cmd.strip().lstrip("/").lstrip("$")):
        if tok in literals or tok in OPERATORS:
            out.append(tok)
        elif tok.startswith("@") and len(tok) >= 2:
            out.append(selector_keys(tok))
        elif tok.startswith("{"):
            out.append("{nbt}")
        elif tok.startswith("["):
            out.append("[list]")
        elif tok.startswith('"') or tok.startswith("'"):
            out.append("STR")
        elif "$(" in tok:
            out.append("MACRO")
        elif (i := id_token(tok)) is not None:
            out.append(i)
        elif COORD.match(tok) and tok[:1] in "~^":
            out.append(tok[0])
        elif NUMBER.match(tok):
            out.append("N")
        else:
            out.append("NAME")
    # 座標3つ組をまとめる
    merged, i = [], 0
    while i < len(out):
        trio = out[i:i + 3]
        if len(trio) == 3 and all(t in ("~", "^", "N") for t in trio):
            kinds = {"~": "rel", "^": "local", "N": "abs"}
            ks = {kinds[t] for t in trio}
            merged.append(f"POS({ks.pop() if len(ks) == 1 else 'mixed'})"); i += 3
        else:
            merged.append(out[i]); i += 1
    return " ".join(merged)


def head_of(pattern):
    """型の先頭：コマンド名。execute なら run の先のコマンド名も付ける"""
    toks = pattern.split(" ")
    if not toks or not toks[0]:
        return "(空)"
    if toks[0] != "execute":
        return toks[0]
    subs = [t for t in toks[1:] if t in EXECUTE_SUBS]
    target = toks[toks.index("run") + 1] if "run" in toks and toks.index("run") + 1 < len(toks) else "(なし)"
    return f"execute[{' '.join(dict.fromkeys(subs))}] run {target}"


EXECUTE_SUBS = {"as", "at", "positioned", "rotated", "facing", "align", "anchored", "in", "on", "summon",
                "store", "if", "unless", "score", "entity", "block", "blocks", "data", "predicate", "function",
                "items", "loaded", "dimension", "biome", "result", "success"}


def function_lines(z, prefix):
    """データパックの関数の実行行（コメントと空行を除く）を返す。ZIP のデータパックの中も読む"""
    lines = []

    def add(text):
        lines.extend(l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#"))
    for name in z.namelist():
        if not name.startswith(prefix):
            continue
        if name.endswith(".mcfunction"):
            add(z.read(name).decode("utf-8", "replace"))
        elif name.lower().endswith(".zip") and prefix:
            try:
                with zipfile.ZipFile(io.BytesIO(z.read(name))) as p:
                    for m in p.namelist():
                        if m.endswith(".mcfunction"):
                            add(p.read(m).decode("utf-8", "replace"))
            except Exception as err:
                print(f"warn: {err}", file=sys.stderr)
    return lines


def scan_worlds(paths):
    """(マップID, コマンドブロック一覧, 関数の行) を返す。マップIDは連番で、名前は出さない"""
    out = []

    def scan(z, label):
        names = z.namelist()
        levels = [n for n in names if n == "level.dat" or n.endswith("/level.dat")]
        for lv in levels:
            base = lv[:-len("level.dat")]
            out.append((label, ex.command_blocks(z, base), function_lines(z, base + "datapacks/")))
        if levels:
            return
        if "pack.mcmeta" in names and any(n.startswith("data/") for n in names):
            out.append((label, [], function_lines(z, "")))
            return
        for n in names:
            if n.lower().endswith(".zip") and "resource" not in n.lower():
                try:
                    with zipfile.ZipFile(io.BytesIO(z.read(n))) as c:
                        scan(c, label)
                except Exception as err:
                    print(f"warn: {err}", file=sys.stderr)
    for p in paths:
        with zipfile.ZipFile(p) as a:
            scan(a, str(p))
    return out


def count(items_by_map):
    """{型: (出現数, マップ数)}"""
    total, maps = collections.Counter(), collections.Counter()
    for items in items_by_map:
        c = collections.Counter(items)
        total.update(c)
        maps.update(c.keys())
    return total, maps


def ranked(total, maps, top):
    return [{"pattern": k, "count": v, "maps": maps[k]} for k, v in total.most_common(top)]


def chain_shape(seq):
    first = seq[0]
    start = f'{first["type"]}{"(常時)" if first["auto"] else "(レッドストーン)"}'
    conds = "".join("?" if c["cond"] else "-" for c in seq[1:])
    return f"{start} 長さ{len(seq) if len(seq) <= 4 else '5+'} 条件{conds[:4] if conds else 'なし'}{'…' if len(conds) > 4 else ''}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reports", required=True, help="データ生成の reports ディレクトリ")
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--markdown", action="store_true", help="表として出す（docs/corpus-patterns.md 用）")
    ap.add_argument("inputs", nargs="*", default=["sample-map"])
    a = ap.parse_args()
    literals, _top = load_literals(str(Path(a.reports) / "commands.json"))
    load_registries(str(Path(a.reports) / "registries.json"))
    paths = []
    for src in map(Path, a.inputs):
        paths += sorted(src.glob("*.zip")) if src.is_dir() else [src]
    worlds = scan_worlds(paths)

    cb_patterns, cb_heads, fn_patterns, fn_heads, selectors, coords, chains = [], [], [], [], [], [], []
    for _label, cbs, lines in worlds:
        ps = [abstract(c["cmd"], literals) for c in cbs if c["cmd"].strip()]
        cb_patterns.append(ps); cb_heads.append([head_of(p) for p in ps])
        fs = [abstract(l, literals) for l in lines]
        fn_patterns.append(fs); fn_heads.append([head_of(p) for p in fs])
        selectors.append([t for p in ps + fs for t in p.split(" ") if t.startswith("@")])
        coords.append([t for p in ps + fs for t in p.split(" ") if t.startswith("POS(")])
        built, _orphans = build_chains(cbs)
        chains.append([chain_shape(s) for s in built])

    result = {
        "maps": len(worlds),
        "commandBlocks": sum(len(c) for _, c, _ in worlds),
        "functionLines": sum(len(l) for _, _, l in worlds),
        "cbHeads": ranked(*count(cb_heads), a.top),
        "cbPatterns": ranked(*count(cb_patterns), a.top),
        "fnHeads": ranked(*count(fn_heads), a.top),
        "fnPatterns": ranked(*count(fn_patterns), a.top),
        "selectors": ranked(*count(selectors), a.top),
        "coordinates": ranked(*count(coords), 10),
        "chainShapes": ranked(*count(chains), 25),
    }
    if a.markdown:
        print_markdown(result)
    else:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=1)


TITLES = {
    "cbHeads": "コマンドブロック：コマンド名（execute はサブコマンドと run の先）",
    "cbPatterns": "コマンドブロック：型",
    "chainShapes": "チェーンの形（起点の種類と起動方法、長さ、2個目以降の条件付き）",
    "fnHeads": "データパックの関数：コマンド名",
    "fnPatterns": "データパックの関数：型",
    "selectors": "セレクタと引数のキー（コマンドブロックと関数の合計）",
    "coordinates": "座標の形式（3つ組。abs=絶対、rel=~、local=^、mixed=混在）",
}


def print_markdown(r):
    print(f"対象：{r['maps']}本、コマンドブロック {r['commandBlocks']}個、関数の実行行 {r['functionLines']}行\n")
    for key, title in TITLES.items():
        print(f"### {title}\n\n| 出現数 | マップ数 | 型 |\n| ---: | ---: | --- |")
        for x in r[key]:
            print(f"| {x['count']} | {x['maps']} | `{x['pattern']}` |")
        print()


if __name__ == "__main__":
    main()
