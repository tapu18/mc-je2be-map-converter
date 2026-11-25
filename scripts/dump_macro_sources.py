#!/usr/bin/env python3
"""Private JSONL input for macro tracing. Never publish the output.

Usage: python3 -I scripts/dump_macro_sources.py <sample-map directory> > /tmp/macro-sources.jsonl
Each world/standalone pack is isolated; function IDs and commands are private.
This mirrors dump_commands.py's archive traversal and does not resolve enabled packs,
pack priority, overlays or function tags.
"""
import io, json, re, sys, zipfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from dump_commands import function_lines
import extract_command_blocks as ex


def scan(z, scope, emit):
    names = z.namelist()
    levels = [n for n in names if n == 'level.dat' or n.endswith('/level.dat')]
    def functions(archive, prefix, world):
        for name in archive.namelist():
            if not name.startswith(prefix):
                continue
            rel = name[len(prefix):]
            if name.endswith('.mcfunction'):
                match = re.search(r'(?:^|/)data/([^/]+)/(?:functions|function)/(.+)\.mcfunction$', rel)
                if match:
                    ident = match.group(1) + ':' + match.group(2)
                    for line in function_lines(archive.read(name).decode('utf-8', 'replace')):
                        emit({'scope': world, 'function': ident, 'cmd': line})
            elif prefix and name.lower().endswith('.zip'):
                try:
                    with zipfile.ZipFile(io.BytesIO(archive.read(name))) as pack:
                        functions(pack, '', world)
                except (zipfile.BadZipFile, OSError):
                    pass
    if levels:
        for i, level in enumerate(levels):
            base = level[:-len('level.dat')]
            world = scope + '/' + str(i)
            for c in ex.command_blocks(z, base):
                if c['cmd'].strip():
                    emit({'scope': world, 'function': None, 'cmd': c['cmd']})
            functions(z, base + 'datapacks/', world)
    elif 'pack.mcmeta' in names and any(n.startswith('data/') for n in names):
        functions(z, '', scope)
    else:
        for i, name in enumerate(names):
            if name.lower().endswith('.zip') and 'resource' not in name.lower():
                try:
                    with zipfile.ZipFile(io.BytesIO(z.read(name))) as nested:
                        scan(nested, scope + '/' + str(i), emit)
                except (zipfile.BadZipFile, OSError):
                    pass


def main():
    src = Path(sys.argv[1])
    paths = sorted(src.glob('*.zip')) if src.is_dir() else [src]
    for i, path in enumerate(paths):
        with zipfile.ZipFile(path) as archive:
            scan(archive, str(i), lambda row: print(json.dumps(row, ensure_ascii=False)))


if __name__ == '__main__':
    main()
