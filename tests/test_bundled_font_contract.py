"""The terminal typeface ships with the app, and the CSS has to keep pointing at it.

Naming an installed font instead of shipping one is what broke the Mac. Measured
on 2026-09-10, that machine had none of the families the presets named -- not
UDEV Gothic, JetBrains Mono, Consolas, BIZ UDGothic nor MS Gothic -- so every
stack fell through to Menlo, whose halfwidth glyph advances 0.602em against a
1.0em fullwidth one. A terminal grid built on that ratio drifts about 3px per
fullwidth character, which is why Japanese tables and box drawing came out
ragged while Windows looked fine.

UDEV Gothic advances 0.5em and 1.0em, so a CJK cell is exactly two ASCII cells.
The things worth breaking a build over: the font files are present and intact,
the @font-face rules point at files that exist, and the default stack still asks
for the bundled family first.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = REPO_ROOT / "src" / "assets" / "fonts"
GLOBAL_CSS = REPO_ROOT / "src" / "global.css"
THEME_STORE = REPO_ROOT / "src" / "stores" / "themeStore.ts"
MAIN_TSX = REPO_ROOT / "src" / "main.tsx"

BUNDLED_FAMILY = "UDEV Gothic NF"
WOFF_FILES = ("UDEVGothicNF-Regular.woff", "UDEVGothicNF-Bold.woff")
REQUIRED_FILES = WOFF_FILES + ("OFL.txt",)

FONT_FACE_BLOCK = re.compile(r"@font-face\s*\{(.*?)\}", re.S)
FONT_FACE_URL = re.compile(r'url\("([^"]+)"\)')
FONT_WEIGHT = re.compile(r"font-weight:\s*(\d+)")
DEFAULT_STACK = re.compile(
    r'export const DEFAULT_TERMINAL_FONT_FAMILY\s*=\s*"([^"]+)"', re.S
)


def _font_face_blocks_for_bundled_family() -> list[str]:
    css = GLOBAL_CSS.read_text(encoding="utf-8")
    return [block for block in FONT_FACE_BLOCK.findall(css) if BUNDLED_FAMILY in block]


def test_bundled_font_files_are_present() -> None:
    missing = [name for name in REQUIRED_FILES if not (FONT_DIR / name).is_file()]
    assert not missing, f"missing bundled font assets: {missing}"


def test_font_files_are_intact() -> None:
    # A WOFF opens with the ASCII signature "wOFF". A checkout that mangled the
    # binary -- line-ending conversion, an unresolved LFS pointer -- fails here
    # rather than at first paint on somebody else's machine.
    for name in WOFF_FILES:
        data = (FONT_DIR / name).read_bytes()
        assert data[:4] == b"wOFF", f"{name} is not a WOFF file"
        assert len(data) > 1_000_000, f"{name} is suspiciously small: {len(data)} bytes"


def test_font_face_rules_reference_existing_files() -> None:
    blocks = _font_face_blocks_for_bundled_family()
    assert blocks, "global.css declares no @font-face for the bundled family"
    for block in blocks:
        urls = FONT_FACE_URL.findall(block)
        assert urls, "a bundled @font-face block has no src url"
        for url in urls:
            target = (GLOBAL_CSS.parent / url).resolve()
            assert target.is_file(), f"@font-face points at a missing file: {url}"


def test_font_face_declares_both_weights() -> None:
    weights = set()
    for block in _font_face_blocks_for_bundled_family():
        found = FONT_WEIGHT.search(block)
        if found:
            weights.add(found.group(1))
    # Bold matters as much as regular: the terminal draws ANSI bold with it, and
    # a synthesised bold has different metrics from the real face.
    assert {"400", "700"} <= weights, f"expected 400 and 700, found {sorted(weights)}"


def test_font_face_blocks_rendering_until_ready() -> None:
    # The WebGL renderer bakes a glyph atlas from whatever face is live at first
    # paint. `swap` would let it bake fallback metrics and keep them all session.
    for block in _font_face_blocks_for_bundled_family():
        assert "font-display: block" in block, "bundled faces must use font-display: block"


def test_default_terminal_stack_leads_with_the_bundled_family() -> None:
    match = DEFAULT_STACK.search(THEME_STORE.read_text(encoding="utf-8"))
    assert match, "DEFAULT_TERMINAL_FONT_FAMILY not found"
    first = match.group(1).split(",")[0].strip().strip("'\"")
    assert first == BUNDLED_FAMILY, f"default stack leads with {first!r}, not the bundled face"


def test_startup_waits_for_the_bundled_font_before_mounting() -> None:
    # Without an explicit fonts.load() nothing downloads the face: an @font-face
    # is lazy, and fonts.ready resolves while the face is still unloaded.
    source = MAIN_TSX.read_text(encoding="utf-8")
    assert "document.fonts.load" in source, "main.tsx must load the bundled face explicitly"
    assert BUNDLED_FAMILY in source, "main.tsx must name the bundled family"
    assert source.index("document.fonts.load") < source.index(
        "ReactDOM.createRoot"
    ), "the font load must be declared before the mount"
