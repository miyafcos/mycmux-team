#!/usr/bin/env python3
"""Re-fetch and re-encode the bundled wallpapers from their original sources.

The ledger ``src/assets/WALLPAPER_SOURCES.md`` records, for each of the 59
bundled wallpapers, where the original came from and whether redistributing it
is settled.  This script reads that ledger and, for the rows the operator
selects, downloads (or copies) the original, downscales it so the long edge is
at most ``--max-edge`` pixels, re-encodes it as WebP, and overwrites the file in
``src/assets``.

Nothing is overwritten unless ``--apply`` is passed; the default is a dry run.

Why Pillow and not ffmpeg
-------------------------
``cwebp`` is not installed on this machine.  The two remaining options were
ffmpeg (full build) and Pillow 12.2.0.  Pillow was chosen because:

* It links the same libwebp encoder that ``cwebp`` uses and exposes ``quality``
  and ``method`` directly, so the settings below mean exactly what the libwebp
  documentation says they mean.  ffmpeg's ``libwebp`` wrapper reinterprets
  ``-quality``/``-compression_level`` through its own option plumbing, which
  makes the resulting bitrate harder to reason about and to reproduce.
* Decoding, resampling and encoding happen in one process, so the downscale can
  use Lanczos explicitly instead of relying on whichever ``sws_flags`` default
  the local ffmpeg build was compiled with.
* The safety check that the downloaded original really is the image currently
  shipped (see ``perceptual_distance``) needs pixel access anyway.  Doing it in
  the same process avoids writing intermediate files just to compare them.

Why quality=90 / method=6
-------------------------
The bundled files are compressed far too hard: the median is 36.3 KB per
megapixel and 37 of the 59 files sit below 60 KB/MP.  ``cwebp -q 90`` on
photographic content lands around 120 KB/MP, which is the target.  A trial
re-encode of the 58 wallpapers whose originals could be located, run with these
exact settings, produced 29.79 MiB (from 11.98 MiB) and put photographic
material in the 120-260 KB/MP band -- i.e. the settings hit the intended target
on this specific corpus rather than on a general rule of thumb.

``method=6`` is the slowest and densest libwebp analysis pass.  These files are
encoded once and then shipped inside the app, so encode time does not matter and
the extra few percent of compression does.

Downscaling policy
------------------
Images are only ever made smaller.  Several originals (for example the
Catppuccin ``artificial-valley`` at 1920x1030) are already below the target long
edge; upscaling them would add bytes without adding detail, so the resize step
is skipped for those and the native resolution is kept.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import io
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

try:
    from PIL import Image
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required: pip install Pillow")

Image.MAX_IMAGE_PIXELS = None

# The ledger is Japanese and Windows consoles still default to cp932, which
# would raise UnicodeEncodeError the moment a licence note is printed.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT: Path = Path(__file__).resolve().parents[2]
LEDGER_PATH: Path = REPO_ROOT / "src" / "assets" / "WALLPAPER_SOURCES.md"
TABLE_BEGIN = "<!-- LEDGER-TABLE-BEGIN -->"
TABLE_END = "<!-- LEDGER-TABLE-END -->"

VERDICT_OK = "再取得可"
VERDICT_REVIEW = "要判断"
VERDICT_BLOCKED = "再取得不可 (据え置き)"
UNKNOWN_SOURCE = "未特定"

# ASCII aliases, so --verdict is typable on a cp932 console.
VERDICT_ALIASES: dict[str, str] = {
    "ok": VERDICT_OK,
    "review": VERDICT_REVIEW,
    "blocked": VERDICT_BLOCKED,
}

DEFAULT_MAX_EDGE = 3840
DEFAULT_QUALITY = 90
DEFAULT_METHOD = 6

# Mean per-channel absolute difference between two images downscaled to 16x16.
# Verified matches on this corpus scored 0.07-1.28; mismatches scored 18-117.
IDENTITY_THRESHOLD = 12.0

USER_AGENT = "mycmux-wallpaper-refresh/1.0"


@dataclass(frozen=True)
class LedgerRow:
    """One wallpaper as recorded in WALLPAPER_SOURCES.md."""

    number: int
    rel_path: str
    preset_id: str
    label: str
    current_size: str
    current_bytes: int
    kb_per_mp: str
    source: str
    source_size: str
    license_note: str
    verdict: str

    @property
    def abs_path(self) -> Path:
        return REPO_ROOT / self.rel_path

    @property
    def is_remote(self) -> bool:
        return self.source.startswith(("http://", "https://"))

    @property
    def has_source(self) -> bool:
        return self.source not in ("", "-", UNKNOWN_SOURCE)


def parse_ledger(path: Path = LEDGER_PATH) -> list[LedgerRow]:
    """Read the marked-off markdown table out of the ledger.

    Only the block between the LEDGER-TABLE markers is parsed, so prose
    elsewhere in the file can contain pipe characters without breaking this.
    """
    text = path.read_text(encoding="utf-8")
    try:
        block = text.split(TABLE_BEGIN, 1)[1].split(TABLE_END, 1)[0]
    except IndexError as exc:
        raise SystemExit(f"ledger markers not found in {path}") from exc

    rows: list[LedgerRow] = []
    for line in block.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) != 11:
            continue
        if not re.fullmatch(r"\d+", cells[0]):
            continue  # header row or the ---|--- separator
        rows.append(
            LedgerRow(
                number=int(cells[0]),
                rel_path=cells[1],
                preset_id=cells[2],
                label=cells[3],
                current_size=cells[4],
                current_bytes=int(cells[5]),
                kb_per_mp=cells[6],
                source=cells[7],
                source_size=cells[8],
                license_note=cells[9],
                verdict=cells[10],
            )
        )
    return rows


def select_rows(
    rows: Sequence[LedgerRow],
    *,
    only: Sequence[str],
    verdicts: Sequence[str],
    select_all: bool,
) -> list[LedgerRow]:
    """Resolve the --only / --verdict / --all selectors into concrete rows.

    ``--only`` accepts a preset id, a repo-relative path, or a bare file name,
    so a single wallpaper can always be addressed without typing a full path.
    """
    if only:
        picked: list[LedgerRow] = []
        for token in only:
            matches = [
                r
                for r in rows
                if token == r.preset_id
                or token == r.rel_path
                or token == Path(r.rel_path).name
                or token == Path(r.rel_path).stem
            ]
            if not matches:
                raise SystemExit(f"--only {token!r} matched no ledger row")
            if len(matches) > 1:
                names = ", ".join(m.rel_path for m in matches)
                raise SystemExit(f"--only {token!r} is ambiguous: {names}")
            picked.extend(matches)
        return picked

    if select_all:
        return list(rows)

    wanted = {VERDICT_ALIASES.get(v, v) for v in verdicts} if verdicts else {VERDICT_OK}
    unknown = wanted - {VERDICT_OK, VERDICT_REVIEW, VERDICT_BLOCKED}
    if unknown:
        raise SystemExit(
            f"unknown --verdict value(s): {', '.join(sorted(unknown))}. "
            f"Use one of: {', '.join(VERDICT_ALIASES)}"
        )
    return [r for r in rows if r.verdict in wanted]


def fetch_source(row: LedgerRow, cache_dir: Path) -> bytes:
    """Return the bytes of the original image for ``row``.

    Remote sources are cached under ``cache_dir`` so repeated dry runs and a
    subsequent --apply do not re-download the same multi-megabyte originals.
    """
    if not row.is_remote:
        local = Path(row.source)
        if not local.is_file():
            raise FileNotFoundError(f"local source missing: {local}")
        return local.read_bytes()

    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"{row.number:02d}_{Path(row.rel_path).stem}{Path(row.source).suffix or '.bin'}"
    if cached.is_file() and cached.stat().st_size > 0:
        return cached.read_bytes()

    request = urllib.request.Request(row.source, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 - fixed ledger URLs
        payload: bytes = response.read()
    cached.write_bytes(payload)
    return payload


def _fingerprint(image: Image.Image) -> bytes:
    """Flatten the image to a 16x16 RGB byte string (768 bytes)."""
    return image.convert("RGB").resize((16, 16)).tobytes()


def perceptual_distance(a: Image.Image, b: Image.Image) -> float:
    """Mean per-channel absolute difference of two 16x16 thumbnails.

    Cheap, resolution independent, and good enough to catch the one failure mode
    that matters here: a source URL that still resolves but now serves a
    different picture than the one currently shipped.
    """
    fa, fb = _fingerprint(a), _fingerprint(b)
    return sum(abs(x - y) for x, y in zip(fa, fb)) / len(fa)


def encode_webp(
    source: Image.Image,
    *,
    max_edge: int,
    quality: int,
    method: int,
) -> tuple[bytes, tuple[int, int]]:
    """Downscale (never upscale) and encode to WebP. Returns bytes and size."""
    image = source.convert("RGB")
    width, height = image.size
    longest = max(width, height)
    if longest > max_edge:
        scale = max_edge / longest
        image = image.resize((round(width * scale), round(height * scale)), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=quality, method=method)
    return buffer.getvalue(), image.size


def backup_original(row: LedgerRow, backup_dir: Path) -> Path:
    """Copy the current file into the backup tree, preserving its subfolder."""
    destination = backup_dir / Path(row.rel_path).relative_to("src/assets")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(row.abs_path, destination)
    return destination


def process_row(
    row: LedgerRow,
    *,
    apply_changes: bool,
    max_edge: int,
    quality: int,
    method: int,
    backup_dir: Path,
    cache_dir: Path,
    skip_identity_check: bool,
) -> bool:
    """Handle one wallpaper. Returns True when it was (or would be) rewritten."""
    prefix = f"[{row.number:02d}] {row.rel_path}"

    if not row.has_source:
        print(f"{prefix}: SKIP - no source recorded ({row.source or 'empty'})")
        return False
    if row.verdict == VERDICT_BLOCKED:
        print(f"{prefix}: SKIP - ledger verdict is {VERDICT_BLOCKED}")
        return False
    if not row.abs_path.is_file():
        print(f"{prefix}: SKIP - current file missing")
        return False

    try:
        payload = fetch_source(row, cache_dir)
    except (urllib.error.URLError, OSError) as exc:
        print(f"{prefix}: FAIL - could not fetch {row.source}: {exc}")
        return False

    try:
        original = Image.open(io.BytesIO(payload))
        original.load()
    except OSError as exc:
        print(f"{prefix}: FAIL - source is not a readable image: {exc}")
        return False

    with Image.open(row.abs_path) as current:
        current.load()
        if not skip_identity_check:
            distance = perceptual_distance(current, original)
            if distance > IDENTITY_THRESHOLD:
                print(
                    f"{prefix}: FAIL - source no longer matches the shipped image "
                    f"(distance {distance:.2f} > {IDENTITY_THRESHOLD}). Refusing to overwrite."
                )
                return False
        old_bytes = row.abs_path.stat().st_size

    encoded, new_size = encode_webp(
        original, max_edge=max_edge, quality=quality, method=method
    )
    ratio = len(encoded) / old_bytes if old_bytes else 0.0
    print(
        f"{prefix}: {original.size[0]}x{original.size[1]} source -> "
        f"{new_size[0]}x{new_size[1]} webp q{quality}, "
        f"{old_bytes:,} -> {len(encoded):,} bytes (x{ratio:.1f})"
    )

    if not apply_changes:
        return True

    saved = backup_original(row, backup_dir)
    print(f"{prefix}: backed up to {saved}")
    row.abs_path.write_bytes(encoded)
    print(f"{prefix}: written")
    return True


def print_listing(rows: Iterable[LedgerRow]) -> None:
    for row in rows:
        source = row.source if row.has_source else UNKNOWN_SOURCE
        if len(source) > 62:
            source = source[:59] + "..."
        print(f"{row.number:>3}  {row.verdict:<18}  {row.preset_id:<30}  {source}")


def build_parser() -> argparse.ArgumentParser:
    today = _dt.date.today().strftime("%Y%m%d")
    parser = argparse.ArgumentParser(
        prog="refresh.py",
        description=(
            "Re-fetch bundled wallpapers from the sources recorded in "
            "src/assets/WALLPAPER_SOURCES.md and re-encode them as high quality WebP. "
            "Dry run by default; pass --apply to overwrite."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  refresh.py --list\n"
            "  refresh.py --only macos_monterey\n"
            "  refresh.py --only koi_bg --apply\n"
            "  refresh.py --verdict ok --apply\n"
        ),
    )
    parser.add_argument("--list", action="store_true", help="print the ledger rows and exit")
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="TARGET",
        help="process a single wallpaper by preset id, repo-relative path, or file name "
        "(repeatable; overrides --verdict/--all)",
    )
    parser.add_argument(
        "--verdict",
        action="append",
        default=[],
        metavar="VERDICT",
        help="process every row with this ledger verdict: ok / review / blocked "
        "(the Japanese literals from the ledger are accepted too). Default: ok",
    )
    parser.add_argument("--all", action="store_true", help="process every row in the ledger")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="actually overwrite the files (without this flag nothing is written)",
    )
    parser.add_argument(
        "--allow-review",
        action="store_true",
        help=f"also process rows whose verdict is '{VERDICT_REVIEW}' (licence not settled)",
    )
    parser.add_argument(
        "--max-edge", type=int, default=DEFAULT_MAX_EDGE, metavar="PX",
        help=f"longest edge after downscaling; never upscales (default: {DEFAULT_MAX_EDGE})",
    )
    parser.add_argument(
        "--quality", type=int, default=DEFAULT_QUALITY, metavar="Q",
        help=f"WebP quality 0-100 (default: {DEFAULT_QUALITY})",
    )
    parser.add_argument(
        "--method", type=int, default=DEFAULT_METHOD, metavar="M",
        help=f"libwebp effort 0-6 (default: {DEFAULT_METHOD})",
    )
    parser.add_argument(
        "--backup-dir", type=Path,
        default=REPO_ROOT / "src" / "assets" / f"_wallpaper_backup_{today}",
        help="where the current files are copied before being overwritten "
        "(default: src/assets/_wallpaper_backup_<today>)",
    )
    parser.add_argument(
        "--cache-dir", type=Path,
        default=Path(tempfile.gettempdir()) / "mycmux-wallpaper-cache",
        help="download cache for the originals; kept outside the repo so a dry run "
        "never leaves untracked files behind (default: <temp>/mycmux-wallpaper-cache)",
    )
    parser.add_argument(
        "--skip-identity-check", action="store_true",
        help="do not verify that the fetched original still matches the shipped image "
        "(only for deliberately replacing a wallpaper with a different picture)",
    )
    parser.add_argument("--ledger", type=Path, default=LEDGER_PATH, help=argparse.SUPPRESS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    rows = parse_ledger(args.ledger)
    print(f"ledger: {args.ledger} ({len(rows)} rows)")

    if args.list:
        print_listing(rows)
        return 0

    selected = select_rows(
        rows, only=args.only, verdicts=args.verdict, select_all=args.all
    )
    if not args.allow_review:
        held = [r for r in selected if r.verdict == VERDICT_REVIEW]
        if held:
            for row in held:
                print(f"[{row.number:02d}] {row.rel_path}: HELD - {VERDICT_REVIEW} ({row.license_note})")
            print(
                f"{len(held)} row(s) held back because the licence is not settled. "
                "Pass --allow-review to process them anyway."
            )
        selected = [r for r in selected if r.verdict != VERDICT_REVIEW]

    if not selected:
        print("nothing selected")
        return 0

    mode = "APPLY" if args.apply else "DRY RUN (nothing will be written)"
    print(f"mode: {mode}; {len(selected)} wallpaper(s) selected")
    if args.apply:
        args.backup_dir.mkdir(parents=True, exist_ok=True)
        print(f"backups: {args.backup_dir}")

    changed = 0
    for row in selected:
        if process_row(
            row,
            apply_changes=args.apply,
            max_edge=args.max_edge,
            quality=args.quality,
            method=args.method,
            backup_dir=args.backup_dir,
            cache_dir=args.cache_dir,
            skip_identity_check=args.skip_identity_check,
        ):
            changed += 1

    verb = "rewritten" if args.apply else "would be rewritten"
    print(f"done: {changed}/{len(selected)} {verb}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
