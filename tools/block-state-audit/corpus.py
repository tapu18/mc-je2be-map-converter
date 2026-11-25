#!/usr/bin/env python3
"""Count saved terrain occurrences of the measured states, without extracting map archives."""

from collections import Counter
import csv
from functools import lru_cache
import gzip
import io
import json
from pathlib import Path, PurePosixPath
import re
import struct
import sys
import zipfile
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from extract_command_blocks import normalize_state
from scan_command_blocks import NBT


@lru_cache(maxsize=16384)
def word_counts(word, bits, cells):
    mask = (1 << bits) - 1
    return Counter((word >> (i * bits)) & mask for i in range(cells))


def palette_counts(palette, data, version):
    if len(palette) == 1:
        return {0: 4096}
    bits = max(4, (len(palette) - 1).bit_length())
    counts = Counter()
    if version >= 2529:
        per_word = 64 // bits
        full_words, tail = divmod(4096, per_word)
        if len(data) != full_words + bool(tail):
            raise ValueError("wrong padded palette length")
        for word, repeats in Counter(data[:full_words]).items():
            for index, count in word_counts(word, bits, per_word).items():
                counts[index] += count * repeats
        if tail:
            counts.update(word_counts(data[-1], bits, tail))
    else:
        if len(data) != 4096 * bits // 64:
            raise ValueError("wrong packed palette length")
        words = [word & ((1 << 64) - 1) for word in data]
        mask = (1 << bits) - 1
        for i in range(4096):
            word, shift = divmod(i * bits, 64)
            value = words[word] >> shift
            if shift + bits > 64:
                value |= words[word + 1] << (64 - shift)
            counts[value & mask] += 1
    if max(counts) >= len(palette):
        raise ValueError("palette index out of range")
    return counts


def region_chunks(archive, path):
    raw = archive.read(path)
    rx, rz = map(int, PurePosixPath(path).name.split(".")[1:3])
    for i, entry in enumerate(struct.unpack_from(">1024I", raw)):
        if not entry:
            continue
        offset = (entry >> 8) * 4096
        length, kind = struct.unpack_from(">IB", raw, offset)
        data = raw[offset + 5:offset + 4 + length]
        if kind & 128:
            external = PurePosixPath(path).with_name(f"c.{rx * 32 + i % 32}.{rz * 32 + i // 32}.mcc")
            data = archive.read(str(external))
            kind &= 127
        if kind == 1:
            data = gzip.decompress(data)
        elif kind == 2:
            data = zlib.decompress(data)
        elif kind != 3:
            raise ValueError(f"unsupported region compression {kind}")
        yield NBT(data).root()


def state_key(name, properties):
    if properties:
        return name + "[" + ",".join(f"{k}={v}" for k, v in sorted(properties.items())) + "]"
    return name


def scan(archive, counts, summary, defaults, known, wanted):
    names = archive.namelist()
    levels = [n[:-len("level.dat")] for n in names if n == "level.dat" or n.endswith("/level.dat")]
    if not levels:
        for name in names:
            if name.lower().endswith(".zip") and "resource" not in name.lower():
                with zipfile.ZipFile(io.BytesIO(archive.read(name))) as child:
                    scan(child, counts, summary, defaults, known, wanted)
        return
    summary["worlds"] += len(levels)
    for path in names:
        if not re.search(r"(?:^|/)region/r\.-?\d+\.-?\d+\.mca$", path):
            continue
        if not any(path.startswith(base) for base in levels):
            continue
        summary["regions"] += 1
        for root in region_chunks(archive, path):
            summary["chunks"] += 1
            version = root["DataVersion"]
            chunk = root.get("Level", root)
            for section in chunk.get("sections", chunk.get("Sections", [])):
                if "Blocks" in section:
                    summary["legacySections"] += 1
                    continue
                block_states = section.get("block_states", {})
                palette = block_states.get("palette", section.get("Palette"))
                if not palette:
                    continue
                summary["paletteSections"] += 1
                data = block_states.get("data", section.get("BlockStates", []))
                for index, count in palette_counts(palette, data, version).items():
                    entry = palette[index]
                    # Since 26.1 an all-default state can be stored as a bare string.
                    if isinstance(entry, dict) and set(entry) == {""}:
                        entry = entry[""]
                    name, properties = normalize_state(entry)
                    if name is None:
                        raise ValueError("block palette without a name")
                    if isinstance(entry, str) and "[" not in entry:
                        properties = defaults.get(name, {})
                    key = state_key(name, properties)
                    summary["cells"] += count
                    if key in known:
                        summary["matchedCells"] += count
                    if key in wanted:
                        counts[key] += count


def main():
    corpus, comparison_path, report_path, tsv_path = map(Path, sys.argv[1:])
    comparison = json.loads(comparison_path.read_text())
    wanted = {row["java"] for row in comparison["differences"]}
    report = json.loads(report_path.read_text())
    known = {state_key(name, state.get("properties", {}))
             for name, block in report.items() for state in block["states"]}
    defaults = {name: next(s.get("properties", {}) for s in block["states"] if s.get("default"))
                for name, block in report.items()}
    counts = Counter()
    maps = Counter()
    summary = Counter()
    archives = sorted(corpus.glob("*.zip"))
    if not archives:
        raise ValueError("no corpus ZIPs found")
    for path in archives:
        summary["archives"] += 1
        archive_counts = Counter()
        with zipfile.ZipFile(path) as archive:
            scan(archive, archive_counts, summary, defaults, known, wanted)
        counts.update(archive_counts)
        maps.update(archive_counts.keys())
    write_differences(tsv_path, comparison, counts, maps)
    print(json.dumps(dict(summary), indent=2, sort_keys=True))


def write_differences(path, comparison, counts, maps):
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output, delimiter="\t", lineterminator="\n", quotechar=None, quoting=csv.QUOTE_NONE)
        writer.writerow(["java", "geyser", "chunker_primary", "chunker_extra", "corpus_cells", "corpus_archives"])
        for row in sorted(comparison["differences"], key=lambda row: row["java"]):
            key = row["java"]
            writer.writerow([
                key, row["geyser"], row["chunker"], ";".join(row["extra"]),
                counts.get(key, 0), maps.get(key, 0),
            ])


if __name__ == "__main__":
    main()
