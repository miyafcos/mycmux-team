"""Generate the bundled wallpaper thumbnails from the full-resolution originals.

The originals under ``src/assets/**`` are no longer bundled into the app (see
``docs/design/wallpaper-on-demand.md``); only these thumbnails are, so that the
picker still shows what every wallpaper looks like while offline. They must be
reproducible from the originals, so the encoder settings are pinned here rather
than left to Pillow's defaults, and ``--check`` re-encodes into memory and
compares bytes against what is committed.

Usage:
    python scripts/wallpapers/make_thumbnails.py           # write
    python scripts/wallpapers/make_thumbnails.py --check   # verify only
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCES = REPO_ROOT / "scripts" / "wallpapers" / "sources.json"
THUMB_DIR = REPO_ROOT / "src" / "assets" / "wallpaper-thumbs"

# Pinned so the same original always encodes to the same bytes on a given
# libwebp. Long edge 320px keeps a 150px-wide card crisp on a 2x display.
LONG_EDGE = 320
QUALITY = 72
METHOD = 6


def load_sources() -> list[dict[str, str]]:
    data = json.loads(SOURCES.read_text(encoding="utf-8"))
    return data["wallpapers"]


def encode_thumbnail(source: Path) -> bytes:
    with Image.open(source) as image:
        image = image.convert("RGB")
        width, height = image.size
        if width >= height:
            size = (LONG_EDGE, max(1, round(height * LONG_EDGE / width)))
        else:
            size = (max(1, round(width * LONG_EDGE / height)), LONG_EDGE)
        resized = image.resize(size, Image.LANCZOS)

    buffer = io.BytesIO()
    # exact=False lets libwebp discard invisible RGB under transparent pixels;
    # the input is already flattened to RGB, so it only affects nothing here.
    resized.save(buffer, format="WEBP", quality=QUALITY, method=METHOD, exact=False)
    return buffer.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args()

    wallpapers = load_sources()
    THUMB_DIR.mkdir(parents=True, exist_ok=True)

    mismatched: list[str] = []
    total = 0
    for entry in wallpapers:
        source = REPO_ROOT / entry["source"]
        if not source.is_file():
            print(f"missing original: {entry['source']}", file=sys.stderr)
            return 2
        encoded = encode_thumbnail(source)
        total += len(encoded)
        target = THUMB_DIR / f"{entry['id']}.webp"
        if args.check:
            if not target.is_file() or target.read_bytes() != encoded:
                mismatched.append(entry["id"])
        elif not target.is_file() or target.read_bytes() != encoded:
            target.write_bytes(encoded)

    expected = {f"{entry['id']}.webp" for entry in wallpapers}
    stray = sorted(path.name for path in THUMB_DIR.glob("*.webp") if path.name not in expected)
    if stray:
        print(f"unexpected thumbnails present: {', '.join(stray)}", file=sys.stderr)
        return 2

    if mismatched:
        print(
            f"{len(mismatched)} thumbnail(s) differ from the originals: "
            f"{', '.join(mismatched)}\nRe-run without --check to regenerate.",
            file=sys.stderr,
        )
        return 1

    print(
        f"{len(wallpapers)} thumbnails, {total} bytes total "
        f"({total / len(wallpapers):.0f} bytes average), Pillow {Image.__version__}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
