#!/usr/bin/env python3
"""JE配布ワールドZIPから、コマンドブロック（ブロックステート付き）とデータパック関数の統計を抽出する。

Usage:
    python3 scripts/extract_command_blocks.py [sample-map ...] > cbs.jsonl

出力: 1ワールド1行のJSON Lines
    world        : "zip名!ワールドのパス"（Shift_JIS由来の文字化けは補正）
    kind         : "world" / "datapack_only"（level.datが無く、ルートにpack.mcmetaがあるZIP）
    cbs          : [{dim, pos, type(impulse/chain/repeat), facing, cond, auto, cmd}]
    fn_files / fn_lines / macro_lines : データパック関数のファイル数・実行行数・マクロ行数
    fn_lines_by_file : {関数パス: 実行行数}
    fn_cmds      : 先頭コマンド名ごとの行数
    advancements : 進捗JSONの数

scan_command_blocks.py のNBTパーサを使う。入力ZIPは展開・変更しない。
26.x系のチャンク形式（パレットが id/properties）にも対応。
"""
import io, sys, zipfile, gzip, zlib, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from scan_command_blocks import NBT

IDS = {"minecraft:command_block": "impulse", "minecraft:chain_command_block": "chain",
       "minecraft:repeating_command_block": "repeat"}


def fixname(n):
    """UTF-8フラグなしのShift_JISファイル名（cp437として読まれたもの）を戻す。"""
    try:
        return n.encode("cp437").decode("cp932")
    except Exception:
        return n


def block_at(sec, lx, ly, lz):
    bs = sec.get("block_states", {}); pal = bs.get("palette", []); data = bs.get("data", [])
    if not pal:
        return {}
    if len(pal) == 1:
        return pal[0]
    bits = max(4, (len(pal) - 1).bit_length()); per = 64 // bits; mask = (1 << bits) - 1
    j = (ly * 16 + lz) * 16 + lx
    v = ((data[j // per] & ((1 << 64) - 1)) >> ((j % per) * bits)) & mask
    return pal[v]


def normalize_state(st):
    """パレット要素を (name, properties) に正規化する。旧形式 Name/Properties、新形式 id/properties、文字列形式に対応。"""
    if isinstance(st, str):
        nm, _, rest = st.partition("[")
        return nm, dict(kv.split("=", 1) for kv in rest.rstrip("]").split(",") if "=" in kv)
    return st.get("Name", st.get("id")), st.get("Properties", st.get("properties", {}))


def iter_chunks(data):
    for idx in range(1024):
        off = int.from_bytes(data[idx*4:idx*4+3], "big") * 4096
        if not off:
            continue
        size = int.from_bytes(data[off:off+4], "big"); typ = data[off+4]; payload = data[off+5:off+4+size]
        if typ & 128:  # 外部 .mcc は未対応（サンプルでは未使用）
            continue
        yield gzip.decompress(payload) if typ == 1 else zlib.decompress(payload) if typ == 2 else payload


def command_blocks(z, base):
    cbs = []
    for name in z.namelist():
        if not name.startswith(base) or not name.endswith(".mca"):
            continue
        rel = name[len(base):]
        if "region/" not in rel:
            continue
        dim = rel.rsplit("region/", 1)[0].rstrip("/") or "overworld"
        for raw in iter_chunks(z.read(name)):
            if b"command_block" not in raw:
                continue
            root = NBT(raw).root()
            root = root.get("Level", root)
            secs = {s.get("Y"): s for s in root.get("sections", root.get("Sections", []))}
            for e in root.get("block_entities", root.get("TileEntities", [])):
                if e.get("id") != "minecraft:command_block":
                    continue
                x, y, zz = e["x"], e["y"], e["z"]
                sec = secs.get(y >> 4)
                nm, props = normalize_state(block_at(sec, x & 15, y & 15, zz & 15) if sec else {})
                cbs.append({"dim": dim, "pos": [x, y, zz], "type": IDS.get(nm, nm),
                            "facing": props.get("facing"), "cond": props.get("conditional") == "true",
                            "auto": bool(e.get("auto", 0)), "cmd": e.get("Command", "")})
    return cbs


def function_stats(z, prefix):
    """prefix 配下（"world/datapacks/" や ""）の .mcfunction と、その中のZIPデータパックを集計する。"""
    by_file = {}; cmds = {}; macro = 0; adv = 0

    def add(path, text):
        nonlocal macro
        ls = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
        by_file[path] = len(ls)
        macro += sum(1 for l in ls if l.startswith("$"))
        for l in ls:
            h = l.lstrip("$").split(" ", 1)[0]
            cmds[h] = cmds.get(h, 0) + 1

    for name in z.namelist():
        if not name.startswith(prefix):
            continue
        if name.endswith(".mcfunction"):
            add(fixname(name[len(prefix):]), z.read(name).decode("utf-8", "replace"))
        elif "/advancement" in name and name.endswith(".json"):
            adv += 1
        elif name.lower().endswith(".zip") and prefix:
            try:
                with zipfile.ZipFile(io.BytesIO(z.read(name))) as p:
                    for m in p.namelist():
                        if m.endswith(".mcfunction"):
                            add(fixname(name[len(prefix):]) + "!" + m, p.read(m).decode("utf-8", "replace"))
                        elif "/advancement" in m and m.endswith(".json"):
                            adv += 1
            except Exception as err:
                print(f"warn: {name}: {err}", file=sys.stderr)
    return {"fn_files": len(by_file), "fn_lines": sum(by_file.values()), "macro_lines": macro,
            "fn_lines_by_file": by_file, "fn_cmds": cmds, "advancements": adv}


def emit(rec):
    print(json.dumps(rec, ensure_ascii=False), flush=True)


def scan(z, label):
    names = z.namelist()
    levels = [n for n in names if n == "level.dat" or n.endswith("/level.dat")]
    for lv in levels:
        base = lv[:-len("level.dat")]
        emit({"world": fixname(label + "!" + base), "kind": "world", "cbs": command_blocks(z, base),
              **function_stats(z, base + "datapacks/")})
    if levels:
        return
    if "pack.mcmeta" in names and any(n.startswith("data/") for n in names):
        emit({"world": fixname(label + "!"), "kind": "datapack_only", "cbs": [], **function_stats(z, "")})
        return
    for n in names:
        if n.lower().endswith(".zip") and "resource" not in n.lower():
            try:
                with zipfile.ZipFile(io.BytesIO(z.read(n))) as c:
                    scan(c, label + "!" + n)
            except Exception as err:
                print(f"warn: {label}!{n}: {err}", file=sys.stderr)


def main():
    inputs = sys.argv[1:] or ["sample-map"]
    for src in map(Path, inputs):
        paths = sorted(src.glob("*.zip")) if src.is_dir() else [src]
        for p in paths:
            with zipfile.ZipFile(p) as a:
                scan(a, p.name)


if __name__ == "__main__":
    main()
