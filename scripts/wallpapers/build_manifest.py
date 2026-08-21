"""Build the wallpaper manifest that the app downloads against.

The manifest pins what a downloaded wallpaper must be: its size and its
sha256. It deliberately carries no URL — the app builds one from the pack tag
and the filename (see ``resolve_download_url`` in
``src-tauri/src/commands/wallpapers.rs``), so pointing the app at a different
release is a one-line tag change rather than a rewrite of 59 entries.

Distribution filenames are ``<id>.webp`` rather than the original names: ids
are already unique and URL-safe, and two source directories are free to hold
files of the same name.

Usage:
    python scripts/wallpapers/build_manifest.py           # write
    python scripts/wallpapers/build_manifest.py --check   # verify only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCES = REPO_ROOT / "scripts" / "wallpapers" / "sources.json"
MANIFEST = REPO_ROOT / "src" / "assets" / "wallpaper-manifest.json"


def build() -> dict[str, object]:
    data = json.loads(SOURCES.read_text(encoding="utf-8"))
    entries = []
    for entry in data["wallpapers"]:
        source = REPO_ROOT / entry["source"]
        if not source.is_file():
            raise SystemExit(f"missing original: {entry['source']}")
        raw = source.read_bytes()
        with Image.open(source) as image:
            width, height = image.size
        entries.append(
            {
                "id": entry["id"],
                "filename": f"{entry['id']}.webp",
                "bytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "width": width,
                "height": height,
            }
        )
    return {"packTag": data["packTag"], "wallpapers": entries}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args()

    manifest = build()
    serialised = json.dumps(manifest, indent=2) + "\n"

    if args.check:
        current = MANIFEST.read_text(encoding="utf-8") if MANIFEST.is_file() else ""
        if current != serialised:
            print(
                "src/assets/wallpaper-manifest.json is stale. Re-run without --check.",
                file=sys.stderr,
            )
            return 1
    else:
        MANIFEST.write_text(serialised, encoding="utf-8")

    total = sum(int(entry["bytes"]) for entry in manifest["wallpapers"])  # type: ignore[index]
    print(
        f"{len(manifest['wallpapers'])} wallpapers, {total} bytes, "  # type: ignore[arg-type]
        f"pack tag {manifest['packTag']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
