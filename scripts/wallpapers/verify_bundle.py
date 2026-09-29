"""Prove that a built frontend bundle contains thumbnails and no originals.

Size alone does not prove it — a bundle can shrink for unrelated reasons and
still carry one 2.5 MiB wallpaper. This hashes every webp in the bundle,
emitted as a file or inlined as a ``data:`` URI, and classifies each one
against the manifest's sha256 list and the committed thumbnails.

Exit code 0 means: zero originals present, and all 59 thumbnails accounted for.

Usage:
    python scripts/wallpapers/verify_bundle.py [dist_dir]
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / "src" / "assets" / "wallpaper-manifest.json"
THUMBS = REPO_ROOT / "src" / "assets" / "wallpaper-thumbs"

INLINE_WEBP = re.compile(rb"data:image/webp;base64,([A-Za-z0-9+/=]+)")


def main() -> int:
    dist = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "dist"
    if not dist.is_dir():
        print(f"no bundle at {dist}; run `npm run build` first", file=sys.stderr)
        return 2

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    originals = {entry["sha256"]: entry["id"] for entry in manifest["wallpapers"]}
    thumbnails = {
        hashlib.sha256(path.read_bytes()).hexdigest(): path.stem
        for path in sorted(THUMBS.glob("*.webp"))
    }

    found_originals: list[str] = []
    found_thumbnails: set[str] = set()

    for path in sorted(dist.rglob("*.webp")):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest in originals:
            found_originals.append(f"{path.name} is the original of {originals[digest]}")
        elif digest in thumbnails:
            found_thumbnails.add(thumbnails[digest])

    # Small assets are inlined into the JS chunks rather than emitted as files.
    for path in sorted(dist.rglob("*.js")):
        for encoded in INLINE_WEBP.findall(path.read_bytes()):
            try:
                digest = hashlib.sha256(base64.b64decode(encoded)).hexdigest()
            except ValueError:
                continue
            if digest in originals:
                found_originals.append(f"{path.name} inlines the original of {originals[digest]}")
            elif digest in thumbnails:
                found_thumbnails.add(thumbnails[digest])

    missing = sorted(set(thumbnails.values()) - found_thumbnails)

    print(f"bundle: {dist}")
    print(f"  originals bundled : {len(found_originals)}")
    print(f"  thumbnails bundled: {len(found_thumbnails)} / {len(thumbnails)}")

    if found_originals:
        print("full-resolution wallpapers are in the bundle:", file=sys.stderr)
        for line in found_originals:
            print(f"  {line}", file=sys.stderr)
        return 1
    if missing:
        print("thumbnails missing from the bundle: " + ", ".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
