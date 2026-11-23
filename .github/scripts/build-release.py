"""Build the public ZIP from the repository's checksummed distribution files."""

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = "SHA256SUMS.txt"
DEFAULTS = {
    "mhub-community-assistant/state/qq-provider.json": {"provider": "internal"},
    "mhub-community-assistant/state/runtime-intent.json": {"sync": False, "voice": False},
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def distribution():
    files = {}
    seen = set()
    for line in (ROOT / MANIFEST).read_text(encoding="utf-8").splitlines():
        entry = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if not entry:
            raise ValueError("Invalid checksum manifest entry")
        digest, name = entry.groups()
        path = PurePosixPath(name)
        if (name != path.as_posix() or path.is_absolute() or ".." in path.parts
                or "\\" in name or ":" in name or name.casefold() in seen
                or name == MANIFEST or name in DEFAULTS):
            raise ValueError(f"Invalid distribution path: {name}")
        seen.add(name.casefold())
        source = (ROOT / path).resolve()
        if not source.is_relative_to(ROOT):
            raise ValueError(f"Distribution path leaves the repository: {name}")
        data = source.read_bytes()
        if sha256(data) != digest:
            raise ValueError(f"Source checksum mismatch: {name}")
        files[name] = data
    return files


def build(output, tag):
    files = distribution()
    metadata = json.loads(files["BUILD-INFO.json"])
    version = json.loads(files["mhub-community-assistant/package.json"])["version"]
    package = f"mhubdafeiyu-assistant-{version}"
    if (not re.fullmatch(r"\d+\.\d+\.\d+", version)
            or metadata["projectVersion"] != version or metadata["package"] != package
            or (tag and tag != f"v{version}")):
        raise ValueError("Release tag, BUILD-INFO and package version must agree")
    metadata["builtAtUtc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    files["BUILD-INFO.json"] = json_bytes(metadata)
    files.update({name: json_bytes(value) for name, value in DEFAULTS.items()})
    files[MANIFEST] = "".join(
        f"{sha256(data)}  {name}\n" for name, data in sorted(files.items())
    ).encode("utf-8")

    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"{package}.zip"
    with ZipFile(archive, "x", compression=ZIP_DEFLATED) as bundle:
        for name, data in sorted(files.items()):
            bundle.writestr(f"{package}/{name}", data)
    archive.with_suffix(".zip.sha256").write_text(
        f"{sha256(archive.read_bytes())}  {archive.name}\n", encoding="ascii", newline="\n"
    )
    print(archive)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--tag")
    arguments = parser.parse_args()
    build(arguments.output, arguments.tag)
