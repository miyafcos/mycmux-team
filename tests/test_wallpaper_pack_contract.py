"""The wallpaper pack ships as thumbnails plus a manifest, never as originals.

Nothing here is about taste: it is about the 31.9 MiB of full-resolution webp
under ``src/assets/**`` staying out of the installer while the picker keeps
working offline. The three things worth breaking a build over are that no
original is imported by the frontend, that the manifest the app verifies
downloads against still matches the files on disk, and that all 59 wallpapers
remain present as originals so the pack can be rebuilt.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ASSETS = REPO_ROOT / "src" / "assets"
SOURCES = REPO_ROOT / "scripts" / "wallpapers" / "sources.json"
MANIFEST = ASSETS / "wallpaper-manifest.json"
THUMBS = ASSETS / "wallpaper-thumbs"
PRESETS_TS = REPO_ROOT / "src" / "lib" / "themeBackgrounds.ts"

WALLPAPER_DIRS = (
    "warp-themes",
    "macos-wallpapers",
    "windows-wallpapers",
    "catppuccin-wallpapers",
)

# The whole point of the change: thumbnails are bundled, originals are not.
# 59 thumbnails currently weigh ~306 KiB; the ceiling leaves room to re-encode
# without quietly drifting back toward a megabyte.
THUMBNAIL_BUDGET_BYTES = 700 * 1024


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def preset_ids() -> list[str]:
    text = PRESETS_TS.read_text(encoding="utf-8")
    return re.findall(r'^\s*\{ id: "([^"]+)",', text, re.M)


def test_sources_cover_exactly_the_presets_the_ui_offers() -> None:
    sources = read_json(SOURCES)["wallpapers"]
    source_ids = [entry["id"] for entry in sources]
    assert len(source_ids) == len(set(source_ids)), "duplicate id in sources.json"
    assert source_ids == preset_ids(), (
        "scripts/wallpapers/sources.json and THEME_BACKGROUND_PRESETS have drifted. "
        "Every preset needs a source entry so its thumbnail and manifest row can be built."
    )


def test_every_original_is_still_in_the_repository() -> None:
    """The pack is built from these; losing one loses the wallpaper for good."""
    missing = [
        entry["source"]
        for entry in read_json(SOURCES)["wallpapers"]
        if not (REPO_ROOT / entry["source"]).is_file()
    ]
    assert not missing, "originals are missing from the repository: " + ", ".join(missing)


def test_manifest_matches_the_originals_on_disk() -> None:
    manifest = read_json(MANIFEST)
    sources = {entry["id"]: entry["source"] for entry in read_json(SOURCES)["wallpapers"]}
    assert manifest["packTag"] == read_json(SOURCES)["packTag"]
    assert len(manifest["wallpapers"]) == len(sources)

    stale: list[str] = []
    for entry in manifest["wallpapers"]:
        raw = (REPO_ROOT / sources[entry["id"]]).read_bytes()
        if entry["bytes"] != len(raw) or entry["sha256"] != hashlib.sha256(raw).hexdigest():
            stale.append(entry["id"])
        assert entry["filename"] == f"{entry['id']}.webp"
        assert len(entry["sha256"]) == 64
        assert entry["width"] > 0 and entry["height"] > 0

    assert not stale, (
        "src/assets/wallpaper-manifest.json is stale for: "
        + ", ".join(stale)
        + ". Re-run scripts/wallpapers/build_manifest.py."
    )


def test_a_thumbnail_is_bundled_for_every_wallpaper() -> None:
    """Without these the picker is blank offline, which is where it starts."""
    ids = [entry["id"] for entry in read_json(SOURCES)["wallpapers"]]
    missing = [wallpaper_id for wallpaper_id in ids if not (THUMBS / f"{wallpaper_id}.webp").is_file()]
    assert not missing, "missing thumbnails: " + ", ".join(missing)

    expected = {f"{wallpaper_id}.webp" for wallpaper_id in ids}
    stray = sorted(path.name for path in THUMBS.glob("*") if path.name not in expected)
    assert not stray, "unexpected files in wallpaper-thumbs: " + ", ".join(stray)

    total = sum(path.stat().st_size for path in THUMBS.glob("*.webp"))
    assert total <= THUMBNAIL_BUDGET_BYTES, (
        f"bundled thumbnails weigh {total} bytes, over the {THUMBNAIL_BUDGET_BYTES} budget"
    )


def test_no_full_resolution_wallpaper_is_imported_by_the_frontend() -> None:
    """An import is what puts a file in the installer, so this is the real gate."""
    offenders: list[str] = []
    for path in sorted((REPO_ROOT / "src").rglob("*.ts")) + sorted((REPO_ROOT / "src").rglob("*.tsx")):
        text = path.read_text(encoding="utf-8")
        for directory in WALLPAPER_DIRS:
            for match in re.finditer(rf'["\'][^"\']*assets/{directory}/[^"\']+["\']', text):
                offenders.append(f"{path.relative_to(REPO_ROOT)}: {match.group(0)}")
    assert not offenders, (
        "full-resolution wallpapers must not be referenced from the frontend bundle; "
        "they are downloaded on demand. Offenders: " + "; ".join(offenders)
    )


def test_the_rust_side_reads_the_same_manifest() -> None:
    rust = (REPO_ROOT / "src-tauri" / "src" / "commands" / "wallpapers.rs").read_text(encoding="utf-8")
    match = re.search(r'include_str!\("([^"]+)"\)', rust)
    assert match, "wallpapers.rs must compile the manifest in with include_str!"
    included = (REPO_ROOT / "src-tauri" / "src" / "commands" / match.group(1)).resolve()
    assert included == MANIFEST.resolve(), f"wallpapers.rs includes {included}, expected {MANIFEST}"
