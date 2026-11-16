"""Copy regular ZIP entries only; never let archive paths or links escape the copy."""
import pathlib
import shutil
import stat
import sys
import zipfile

source, destination = sys.argv[1:]
root = pathlib.Path(destination)
with zipfile.ZipFile(source) as archive:
    seen = set()
    for entry in archive.infolist():
        path = pathlib.PurePosixPath(entry.filename)
        mode = entry.external_attr >> 16
        if (path.is_absolute() or ".." in path.parts or "\\" in entry.filename
                or not path.parts or ":" in path.parts[0]
                or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
            raise ValueError(f"unsafe syntax datapack ZIP entry: {entry.filename}")
        if path in seen:
            raise ValueError(f"duplicate syntax datapack ZIP entry: {entry.filename}")
        seen.add(path)
    root.mkdir(parents=True, exist_ok=False)
    for entry in archive.infolist():
        target = root.joinpath(*pathlib.PurePosixPath(entry.filename).parts)
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as src, target.open("xb") as dst:
                # Function bodies, including overlays, must never be executed.
                if target.name.endswith(".mcfunction"):
                    dst.write(b"# je2be: validation-only function placeholder\n")
                else:
                    shutil.copyfileobj(src, dst)
