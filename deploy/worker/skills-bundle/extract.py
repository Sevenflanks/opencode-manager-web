"""Extract data only. No shell, links, devices or upstream execution."""
import json
import pathlib
import re
import sys
import tarfile

archive, target, selection = sys.argv[1:]
roots = json.loads(selection)
destination = pathlib.Path(target)
seen = set()
total = 0
with tarfile.open(archive, "r:gz") as tar:
    for member in tar:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or "\\" in member.name or ":" in member.name or any(re.search(r'[. ]$|^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)', part, re.I) for part in path.parts):
            raise ValueError("unsafe archive path")
        relative = pathlib.PurePosixPath(*path.parts[1:])
        name = str(relative)
        selected = any(name == root or name.startswith(root + "/") for root in roots)
        license_file = len(relative.parts) == 1 and relative.name.lower().startswith(("license", "licence", "copying", "notice"))
        if not (selected or license_file) or member.isdir():
            continue
        if not member.isfile() or member.issym() or member.islnk():
            raise ValueError("unsupported archive entry")
        if name.casefold() in seen or member.size > 16 * 1024 * 1024:
            raise ValueError("duplicate or oversized archive entry")
        seen.add(name.casefold())
        total += member.size
        if total > 128 * 1024 * 1024:
            raise ValueError("archive selection exceeds limit")
        output = destination.joinpath(*relative.parts)
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with output.open("xb") as stream:
            stream.write(tar.extractfile(member).read())
        output.chmod(0o600)
