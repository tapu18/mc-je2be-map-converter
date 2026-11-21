"""Package a closed Bedrock world at the archive root; never overwrite output."""
import pathlib
import sys
import zipfile

world, output = map(pathlib.Path, sys.argv[1:])
entries = sorted(world.rglob("*"))
if any(p.is_symlink() for p in entries):
    raise ValueError("world contains symbolic links")
with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
    for entry in entries:
        if entry.is_file():
            archive.write(entry, entry.relative_to(world).as_posix())
