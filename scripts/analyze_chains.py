#!/usr/bin/env python3
"""extract_command_blocks.py の出力からチェーンを復元し、マップ単位で集計する。

Usage:
    python3 scripts/analyze_chains.py cbs.jsonl [--dump chains.json]

出力:
  1. マップ区分（データパック有無 × コマブロ なし/単発のみ/チェーンあり）
  2. マップごとの統計（チェーン長の分布、リピート、条件付き、コマンド分類、難しい要素）
  3. 全体のコマンド分類とJava専用機能の出現数
--dump を付けると、チェーンごとのコマンド列をJSONで書き出す
（各要素は "種類[?=条件付き][A=常時実行] コマンド"）。

チェーン: インパルス/リピートを起点に、facing方向へ連続するチェーンコマンドブロックをたどる。
データパック「あり」は関数が1行以上あるもの（空の bukkit パック等は「なし」扱い）。
"""
import argparse, collections, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from features import classify_command

DIRS = {"up": (0, 1, 0), "down": (0, -1, 0), "north": (0, 0, -1), "south": (0, 0, 1),
        "east": (1, 0, 0), "west": (-1, 0, 0)}
HARD = ["nbt-selector", "advancements-selector", "execute store", "execute on", "if data/function/items",
        "data", "summon with NBT", "block NBT"]


def build_chains(cbs):
    pos = {(c["dim"], tuple(c["pos"])): c for c in cbs}
    used, chains = set(), []
    for c in cbs:
        if c["type"] == "chain":
            continue
        seq = [c]; seen = {(c["dim"], tuple(c["pos"]))}
        while (d := DIRS.get(seq[-1]["facing"])):
            p = seq[-1]["pos"]; nk = (c["dim"], (p[0] + d[0], p[1] + d[1], p[2] + d[2]))
            n = pos.get(nk)
            if not n or n["type"] != "chain" or nk in seen:
                break
            seen.add(nk); seq.append(n)
        used |= seen; chains.append(seq)
    orphans = [c for c in cbs if (c["dim"], tuple(c["pos"])) not in used]
    return chains, orphans


def short(world):
    name = world.split("!")[0]
    return name[:-4] if name.endswith(".zip") else name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl")
    ap.add_argument("--dump")
    a = ap.parse_args()

    rows, dump = [], []
    tot_kind, tot_feat, heads, tot_len = (collections.Counter() for _ in range(4))
    for line in open(a.jsonl, encoding="utf-8"):
        w = json.loads(line)
        chains, orphans = build_chains(w["cbs"])
        kinds, hard = collections.Counter(), collections.Counter()
        execs = 0
        for c in w["cbs"]:
            k, f, h = classify_command(c["cmd"])
            kinds[k] += 1; tot_kind[k] += 1; heads[h] += 1
            execs += "execute" in c["cmd"]
            for x in set(f):
                tot_feat[x] += 1
                if x in HARD:
                    hard[x] += 1
        lens = [len(s) for s in chains]
        L = collections.Counter("1" if n == 1 else "2-3" if n <= 3 else "4-10" if n <= 10 else "11+" for n in lens)
        tot_len.update(L)
        mx = max(lens, default=0)
        dp = w["fn_lines"] > 0
        cat = ("DPあり" if dp else "DPなし") + "・" + ("コマブロなし" if not w["cbs"] else "単発のみ" if mx <= 1 else "チェーンあり")
        rows.append({"cat": cat, "name": short(w["world"]), "cbs": len(w["cbs"]), "chains": len(chains),
                     "multi": sum(1 for n in lens if n >= 2), "max": mx, "len": dict(L),
                     "repeat": sum(1 for s in chains if s[0]["type"] == "repeat"),
                     "repeat_auto": sum(1 for s in chains if s[0]["type"] == "repeat" and s[0]["auto"]),
                     "cond": sum(c["cond"] for c in w["cbs"]), "orphans": len(orphans), "execute": execs,
                     "kinds": dict(kinds), "hard": dict(hard), "fn": (w["fn_files"], w["fn_lines"], w["macro_lines"])})
        dump.append([w["world"], [[f'{c["type"]}{"?" if c["cond"] else ""}{"A" if c["auto"] else ""} {c["cmd"]}' for c in s]
                                  for s in chains]])

    print("## マップ区分")
    for cat, n in sorted(collections.Counter(r["cat"] for r in rows).items()):
        print(f"{cat}: {n}  ", ", ".join(r["name"] for r in rows if r["cat"] == cat))

    print("\n## マップ別")
    for r in sorted(rows, key=lambda r: r["cat"]):
        print(f'[{r["cat"]}] {r["name"]}: cbs={r["cbs"]} chains={r["chains"]} (2個以上={r["multi"]}, 最長={r["max"]}, {r["len"]}) '
              f'repeat={r["repeat"]}(常時{r["repeat_auto"]}) 条件付き={r["cond"]} 孤立={r["orphans"]} execute={r["execute"]} '
              f'分類={r["kinds"]} 難所={r["hard"]} 関数(files/lines/macro)={r["fn"]}')

    print("\n## 全体")
    print("チェーン長:", dict(tot_len))
    print("コマンド分類:", dict(tot_kind))
    print("Java専用機能（コマブロ数）:", tot_feat.most_common())
    print("先頭コマンド:", heads.most_common(30))

    if a.dump:
        json.dump(dump, open(a.dump, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
