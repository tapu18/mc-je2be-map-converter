#!/usr/bin/env python3
"""データパック関数内のJava専用機能の使用行数をマップごとに数える。

Usage:
    python3 scripts/datapack_features.py [sample-map ...]

各行を features.JAVA_ONLY の正規表現で判定する粗い集計。
ワールド内の datapacks/（ZIP形式のパックを含む）と、ワールドなしのデータパック単体ZIPが対象。
"""
import collections, io, sys, zipfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from features import java_only_features
from extract_command_blocks import fixname


def iter_lines(z, prefix):
    for n in z.namelist():
        if not n.startswith(prefix):
            continue
        if n.endswith(".mcfunction"):
            yield from z.read(n).decode("utf-8", "replace").splitlines()
        elif prefix and n.lower().endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(z.read(n))) as p:
                for m in p.namelist():
                    if m.endswith(".mcfunction"):
                        yield from p.read(m).decode("utf-8", "replace").splitlines()


def report(z, prefix, label):
    c = collections.Counter(); total = 0
    for ln in iter_lines(z, prefix):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        total += 1
        c.update(java_only_features(ln))
    if total:
        print(f"{fixname(label)}: 実行行={total} ", " ".join(f"{k}:{v}" for k, v in c.most_common()))


def scan(z, label):
    names = z.namelist()
    levels = [n for n in names if n == "level.dat" or n.endswith("/level.dat")]
    for lv in levels:
        report(z, lv[:-len("level.dat")] + "datapacks/", label)
    if levels:
        return
    if "pack.mcmeta" in names and any(n.startswith("data/") for n in names):
        report(z, "", label)
        return
    for n in names:
        if n.lower().endswith(".zip") and "resource" not in n.lower():
            with zipfile.ZipFile(io.BytesIO(z.read(n))) as ch:
                scan(ch, label)


def main():
    for src in map(Path, sys.argv[1:] or ["sample-map"]):
        for p in (sorted(src.glob("*.zip")) if src.is_dir() else [src]):
            with zipfile.ZipFile(p) as a:
                scan(a, p.name)


if __name__ == "__main__":
    main()
