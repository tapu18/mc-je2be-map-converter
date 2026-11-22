#!/usr/bin/env python3
"""配布マップのコマンド（コマンドブロックと関数の実行行）を JSON Lines で出す（#13 のパース成功率の集計用）。

出力にはコマンドの文面が含まれる。権利上、リポジトリや Issue に載せず、スクラッチ領域にだけ置くこと。
集計（tools/parse-corpus.ts）は件数と失敗の分類だけを出す。

Usage:
    python3 -I scripts/dump_commands.py [sample-map ...] > <scratch>/commands.jsonl

各行: {"map": 連番, "dataVersion": int|null, "packFormat": int|null, "source": "cb"|"fn", "cmd": str}
関数の行は、行末の `\\` による継続（1.20.2 以降）をつないでから出す。マクロ行（`$` で始まる）もそのまま出す。
"""
import gzip, io, json, sys, zipfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_command_blocks as ex
from scan_command_blocks import NBT


def function_lines(text):
    out, cur = [], None
    for raw in text.splitlines():
        line = raw.strip()
        if cur is not None:
            # 継続行：前の行に、先頭の空白を除いてつなぐ
            line = cur + line
            cur = None
        if line.endswith("\\") and not line.startswith("#"):
            cur = line[:-1]
            continue
        if line and not line.startswith("#"):
            out.append(line)
    if cur:
        out.append(cur)
    return out


def pack_format(z, prefix):
    try:
        pack = json.loads(z.read(prefix + "pack.mcmeta").decode("utf-8-sig")).get("pack", {})
        def version(value):
            if type(value) is int and value >= 0:
                return [value, 0]
            if isinstance(value, list) and len(value) == 2 and all(type(x) is int and x >= 0 for x in value):
                return value
            return None
        if "min_format" in pack or "max_format" in pack:
            lo, hi = version(pack.get("min_format")), version(pack.get("max_format"))
        elif "supported_formats" in pack:
            supported = pack["supported_formats"]
            if isinstance(supported, list) and len(supported) == 2:
                lo, hi = version(supported[0]), version(supported[1])
            elif isinstance(supported, dict):
                lo, hi = version(supported.get("min_inclusive")), version(supported.get("max_inclusive"))
            else:
                lo = hi = version(supported)
        else:
            lo = hi = version(pack.get("pack_format"))
        return {"min": lo, "max": hi} if lo is not None and hi is not None and lo <= hi else None
    except Exception:
        return None


def datapack_functions(z, prefix):
    """prefix 配下の .mcfunction（ZIP のデータパックの中も）を (pack_format, 行) で返す"""
    out = []
    for name in z.namelist():
        if not name.startswith(prefix):
            continue
        if name.endswith(".mcfunction"):
            rel = name[len(prefix):]
            pack = prefix + rel.split("/", 1)[0] + "/" if prefix.endswith("datapacks/") else prefix
            pf = pack_format(z, pack)
            out += [(pf, l) for l in function_lines(z.read(name).decode("utf-8", "replace"))]
        elif name.lower().endswith(".zip") and prefix:
            try:
                with zipfile.ZipFile(io.BytesIO(z.read(name))) as p:
                    pf = pack_format(p, "")
                    for m in p.namelist():
                        if m.endswith(".mcfunction"):
                            out += [(pf, l) for l in function_lines(p.read(m).decode("utf-8", "replace"))]
            except Exception as err:
                print(f"warn: {err}", file=sys.stderr)
    return out


def data_version(z, base):
    try:
        root = NBT(gzip.decompress(z.read(base + "level.dat"))).root()
        return root.get("Data", {}).get("DataVersion")
    except Exception as err:
        print(f"warn: level.dat: {err}", file=sys.stderr)
        return None


def scan(z, emit):
    names = z.namelist()
    levels = [n for n in names if n == "level.dat" or n.endswith("/level.dat")]
    for lv in levels:
        base = lv[:-len("level.dat")]
        dv = data_version(z, base)
        for c in ex.command_blocks(z, base):
            if c["cmd"].strip():
                emit({"dataVersion": dv, "packFormatRange": None, "source": "cb", "cmd": c["cmd"]})
        for pf, line in datapack_functions(z, base + "datapacks/"):
            emit({"dataVersion": dv, "packFormatRange": pf, "source": "fn", "cmd": line})
    if levels:
        return
    if "pack.mcmeta" in names and any(n.startswith("data/") for n in names):
        for pf, line in datapack_functions(z, ""):
            emit({"dataVersion": None, "packFormatRange": pf, "source": "fn", "cmd": line})
        return
    for n in names:
        if n.lower().endswith(".zip") and "resource" not in n.lower():
            try:
                with zipfile.ZipFile(io.BytesIO(z.read(n))) as c:
                    scan(c, emit)
            except Exception as err:
                print(f"warn: {err}", file=sys.stderr)


def main():
    inputs = sys.argv[1:] or ["sample-map"]
    paths = []
    for src in map(Path, inputs):
        paths += sorted(src.glob("*.zip")) if src.is_dir() else [src]
    for i, p in enumerate(paths):
        with zipfile.ZipFile(p) as a:
            scan(a, lambda rec: print(json.dumps({"map": i, **rec}, ensure_ascii=False)))


if __name__ == "__main__":
    main()
