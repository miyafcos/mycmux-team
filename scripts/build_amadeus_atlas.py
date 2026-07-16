#!/usr/bin/env python3
"""Build the Amadeus buddy avatar master atlas from expression grid sheets.

Reads a TOML manifest describing one or more source grid sheets (each a regular
rows x cols grid of distinct facial-expression portraits), slices every cell,
removes the opaque light background (so only the character remains), normalizes
the character to a uniform size, and packs every cell into a single master
spritesheet (WEBP). Also emits a layout JSON mapping expression labels to flat
cell indices, plus the mood / ambient / talking groupings from the manifest.

This script contains no character artwork. The source sheets and the generated
master atlas are copyrighted material and stay local (outside the repo); only
this generic packer lives in the repository.

Usage:
    python scripts/build_amadeus_atlas.py
    python scripts/build_amadeus_atlas.py --manifest <path> --out-sheet <path> --out-layout <path>
"""

from __future__ import annotations

import argparse
import json
import math
import tomllib
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

DEFAULT_PET_DIR = Path.home() / ".codex" / "pets" / "amadeus"
DEFAULT_MANIFEST = DEFAULT_PET_DIR / "_src" / "sheets.toml"
DEFAULT_OUT_SHEET = DEFAULT_PET_DIR / "spritesheet.webp"
DEFAULT_OUT_LAYOUT = DEFAULT_PET_DIR / "layout.json"

# Color flooded into background regions; pure magenta never occurs in the art.
SENTINEL = (255, 0, 255)


class BuildError(RuntimeError):
    """Raised on a manifest or source-asset problem."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pack Amadeus expression sheets into one atlas.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST,
                        help="TOML manifest path (default: <pet>/_src/sheets.toml)")
    parser.add_argument("--src-dir", type=Path, default=None,
                        help="Directory holding the source sheet PNGs (default: manifest's folder)")
    parser.add_argument("--out-sheet", type=Path, default=DEFAULT_OUT_SHEET,
                        help="Output master atlas WEBP path")
    parser.add_argument("--out-layout", type=Path, default=DEFAULT_OUT_LAYOUT,
                        help="Output layout JSON path")
    return parser.parse_args()


def _sentinel_mask(rgb: Image.Image) -> Image.Image:
    """Return an L mask: 255 where the RGB image holds the SENTINEL color."""
    channel_r, channel_g, channel_b = rgb.split()
    is_r = channel_r.point(lambda v: 255 if v == SENTINEL[0] else 0)
    is_g = channel_g.point(lambda v: 255 if v == SENTINEL[1] else 0)
    is_b = channel_b.point(lambda v: 255 if v == SENTINEL[2] else 0)
    return ImageChops.multiply(ImageChops.multiply(is_r, is_g), is_b)


def _count(mask: Image.Image) -> int:
    """Count pixels valued 255 in a 0/255 L mask."""
    return mask.histogram()[255]


def _tone_masks(rgb: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Return (light, dark) 0/255 L masks for the two flat checker tones."""
    red, green, blue = rgb.split()
    hi = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    lo = ImageChops.darker(ImageChops.darker(red, green), blue)
    gray = ImageChops.subtract(hi, lo).point(lambda v: 255 if v <= 8 else 0)
    light = ImageChops.multiply(gray, lo.point(lambda v: 255 if v >= 249 else 0))
    dark = ImageChops.multiply(gray, lo.point(lambda v: 255 if 234 <= v <= 246 else 0))
    return light, dark


def _border_flood(work: Image.Image, thresh: int) -> Image.Image:
    """Flood-fill the connected checker background from every cell edge.

    A candidate fill is kept only if it is checker-textured: at least 20% of
    the filled pixels carry the dark checker tone. A near-uniform fill (the
    white lab coat, if a bottom-edge seed lands on it) lacks that tone and is
    rejected -- so the whole perimeter, bottom edge included, can be seeded.
    Long hair touching the side edges otherwise isolates the bottom corners.
    """
    width, height = work.size
    _, dark = _tone_masks(work)
    seeds: list[tuple[int, int]] = []
    for fx in (0.02, 0.16, 0.3, 0.45, 0.55, 0.7, 0.84, 0.98):
        seeds.append((int(fx * width), 3))                    # top edge
        seeds.append((int(fx * width), height - 4))           # bottom edge
    for fy in (0.1, 0.3, 0.5, 0.7, 0.9):
        seeds.append((3, int(fy * height)))                   # left edge
        seeds.append((width - 4, int(fy * height)))           # right edge

    mask = Image.new("L", (width, height), 0)
    for seed in seeds:
        pixel = work.getpixel(seed)
        if pixel == SENTINEL:
            continue                                          # already flooded
        if min(pixel) < 200:
            continue                                          # seed on the character
        probe = work.copy()
        ImageDraw.floodfill(probe, seed, SENTINEL, thresh=thresh)
        filled = _sentinel_mask(probe)
        filled_count = _count(filled)
        if filled_count == 0:
            continue
        dark_count = _count(ImageChops.multiply(dark, filled))
        if dark_count / filled_count < 0.20:
            continue                                          # uniform region, not checker
        mask = ImageChops.lighter(mask, filled)
        work.paste(SENTINEL, (0, 0), filled)                  # short-circuit later seeds
    return mask


def _checker_mask(work: Image.Image, period: int) -> Image.Image:
    """Detect checker patches enclosed by the character (reached by no seed).

    Tests the alternating pattern directly: a checker pixel carries one flat
    tone while the opposite tone sits half a period away on both axes. The
    smoothly shaded lab coat is locally uniform and never alternates, so it is
    not flagged. Works on strips only ~one period wide.
    """
    light, dark = _tone_masks(work)
    half = max(2, round(period / 2))

    def opposite_present(opposite: Image.Image) -> Image.Image:
        horizontal = ImageChops.lighter(ImageChops.offset(opposite, half, 0),
                                        ImageChops.offset(opposite, -half, 0))
        vertical = ImageChops.lighter(ImageChops.offset(opposite, 0, half),
                                      ImageChops.offset(opposite, 0, -half))
        return ImageChops.multiply(horizontal, vertical)

    checker = ImageChops.lighter(ImageChops.multiply(dark, opposite_present(light)),
                                 ImageChops.multiply(light, opposite_present(dark)))
    return checker.filter(ImageFilter.MaxFilter(3))


def cutout_background(cell: Image.Image, thresh: int, checker_period: int) -> Image.Image:
    """Make the baked checkerboard / flat background transparent.

    Combines a leak-guarded border flood (removes the connected background
    with crisp character edges) with a checker-pattern detector (mops up
    background patches enclosed by the character, e.g. between a raised hand
    and the torso).
    """
    work = cell.convert("RGB")
    background = ImageChops.lighter(
        _border_flood(work, thresh),
        _checker_mask(work, checker_period),
    )
    rgba = cell.convert("RGBA")
    rgba.putalpha(ImageChops.invert(background))
    return rgba


TOP_MARGIN = 10           # px reserved above the crown across all cells
ALPHA_THRESHOLD = 50      # ignore antialiasing fringe when measuring widths
TARGET_BUST_RATIO = 0.80  # bust width as a fraction of target_w


def _measure_bust_width(cropped: Image.Image) -> int:
    """Width of the bust silhouette at the lower 85-97% band of the cropped cell.

    Returns the max non-transparent run width in that y band. Bust geometry
    (shoulders, collar, tie) is the most stable per-cell character feature:
    faces deform with expressions but the bust hardly does, so it is the
    right per-cell anchor for normalizing character size across expressions.
    """
    alpha = np.asarray(cropped.getchannel("A"))
    h = alpha.shape[0]
    y_lo = int(h * 0.85)
    y_hi = min(h, int(h * 0.97))
    max_w = 0
    for y in range(y_lo, y_hi):
        row = alpha[y] > ALPHA_THRESHOLD
        if row.any():
            nz = row.nonzero()[0]
            w = int(nz[-1] - nz[0] + 1)
            if w > max_w:
                max_w = w
    return max_w


def place_cell_normalized(cropped: Image.Image, target_w: int, target_h: int,
                          scale: float, top_margin: int) -> Image.Image:
    """Place a bbox-cropped cell using a PER-CELL scale + fixed top anchor.

    The caller has already cropped `rgba` to its non-transparent bbox and has
    pre-computed `scale` from this cell's bust width versus the shared target.
    Per-cell scaling guarantees every cell shows the SAME bust width, so the
    character's body size is identical across all expressions. The fixed top
    margin locks the crown at a constant y. Together this kills both the
    head-bob and the body-resize wobble that plagued earlier passes.
    """
    fit_w = max(1, round(cropped.width * scale))
    fit_h = max(1, round(cropped.height * scale))
    if fit_h + top_margin > target_h:
        fit_h = target_h - top_margin
    resized = cropped.resize((fit_w, fit_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    if fit_w > target_w:
        x_crop = (fit_w - target_w) // 2
        resized = resized.crop((x_crop, 0, x_crop + target_w, fit_h))
        canvas.paste(resized, (0, top_margin), resized)
    else:
        canvas.paste(resized, ((target_w - fit_w) // 2, top_margin), resized)
    return canvas


def _checker_only_mask(rgb: Image.Image) -> Image.Image:
    """Return a 0/255 L mask: 255 where the pixel matches either flat checker tone."""
    light, dark = _tone_masks(rgb)
    return ImageChops.lighter(light, dark)


def _gutter_runs(line_is_bg: np.ndarray, min_run: int) -> list[tuple[int, int]]:
    """Return [(start, end), ...] of consecutive True runs in line_is_bg.

    Each (start, end) is a half-open interval. Runs shorter than min_run are
    dropped (they are scanline noise, not a real gutter).
    """
    runs: list[tuple[int, int]] = []
    n = int(line_is_bg.size)
    i = 0
    while i < n:
        if bool(line_is_bg[i]):
            j = i
            while j < n and bool(line_is_bg[j]):
                j += 1
            if j - i >= min_run:
                runs.append((i, j))
            i = j
        else:
            i += 1
    return runs


def _gutter_centers(mask: Image.Image, axis: int, min_run: int = 4) -> list[int]:
    """Return the center of each fully-bg run along `axis`.

    axis=0 detects horizontal gutters and returns y centers (row boundaries).
    axis=1 detects vertical gutters and returns x centers (col boundaries).
    A scanline is fully-bg iff every pixel along the orthogonal axis is masked.
    """
    arr = np.asarray(mask)
    perpendicular = 1 - axis
    line_is_bg = (arr == 255).all(axis=perpendicular)
    return [(start + end) // 2 for start, end in _gutter_runs(line_is_bg, min_run)]


def _boxes_from_gutters(h_centers: list[int], v_centers: list[int],
                        cols: int, rows: int,
                        sheet_w: int, sheet_h: int) -> list[tuple[int, int, int, int]] | None:
    """Build row-major cell boxes from gutter centers.

    Returns None if the detected gutter counts do not match the expected grid
    or if the outermost gutters do not anchor near the sheet edges (a sign that
    the detector got confused).
    """
    if len(h_centers) != rows + 1 or len(v_centers) != cols + 1:
        return None
    h_margin = sheet_h // (rows * 4)
    v_margin = sheet_w // (cols * 4)
    if h_centers[0] > h_margin or h_centers[-1] < sheet_h - h_margin:
        return None
    if v_centers[0] > v_margin or v_centers[-1] < sheet_w - v_margin:
        return None
    boxes: list[tuple[int, int, int, int]] = []
    for r in range(rows):
        y0, y1 = h_centers[r], h_centers[r + 1]
        for c in range(cols):
            x0, x1 = v_centers[c], v_centers[c + 1]
            boxes.append((x0, y0, x1, y1))
    return boxes


def slice_sheet_raw(sheet: Image.Image, cols: int, rows: int,
                    source_has_alpha: bool, bg_thresh: int,
                    checker_period: int) -> list[Image.Image]:
    """Slice a sheet into rows*cols transparent cells (no placement).

    Strategy: detect horizontal/vertical gutters (rows/columns that are
    entirely blank — α=0 for transparent sheets, checker-tone for baked-
    background sheets) and cut cells on those gutters. This keeps each cell
    inside the bust's actual frame even when bust bottoms (shoulders, collar,
    tie) overhang the nominal uniform grid -- which is what was bleeding the
    "上端の帯" into the rows below before. Falls back to a uniform grid when
    the detector cannot find the expected gutter counts (preserves prior
    behavior).

    Baked-background cells get cutout_background applied after slicing;
    truly transparent cells are passed through as-is. Final placement (bbox
    crop + shared scale + top-anchor) is done in build().
    """
    if source_has_alpha:
        alpha = sheet.getchannel("A")
        mask = alpha.point(lambda v: 255 if v == 0 else 0)
    else:
        mask = _checker_only_mask(sheet.convert("RGB"))

    h_centers = _gutter_centers(mask, axis=0)
    v_centers = _gutter_centers(mask, axis=1)
    boxes = _boxes_from_gutters(h_centers, v_centers, cols, rows,
                                sheet.width, sheet.height)
    if boxes is None:
        print(f"  WARN: gutter detect failed (h={len(h_centers)}, "
              f"v={len(v_centers)}; expected {rows + 1}/{cols + 1}); "
              f"falling back to uniform grid")
        cell_w = sheet.width / cols
        cell_h = sheet.height / rows
        boxes = [(round(c * cell_w), round(r * cell_h),
                  round((c + 1) * cell_w), round((r + 1) * cell_h))
                 for r in range(rows) for c in range(cols)]
    else:
        print(f"  gutter detect ok: h={h_centers}, v={v_centers}")

    cells: list[Image.Image] = []
    for box in boxes:
        raw = sheet.crop(box)
        transparent = raw if source_has_alpha else cutout_background(raw, bg_thresh, checker_period)
        cells.append(transparent)
    return cells


def load_manifest(path: Path) -> dict:
    if not path.is_file():
        raise BuildError(f"manifest not found: {path}")
    with path.open("rb") as handle:
        return tomllib.load(handle)


def apply_aliases(expressions: dict[str, list[int]], aliases: object) -> dict[str, str]:
    if aliases is None:
        return {}
    if not isinstance(aliases, dict):
        raise BuildError("[aliases] must be a TOML table")

    normalized: dict[str, str] = {}
    for alias, target in aliases.items():
        if not isinstance(alias, str) or not isinstance(target, str):
            raise BuildError("[aliases] entries must map strings to strings")
        if target not in expressions:
            raise BuildError(f"alias {alias!r} targets missing label: {target}")
        if alias in expressions and alias != target:
            raise BuildError(f"alias {alias!r} conflicts with a cell label")
        normalized[alias] = target
        expressions[alias] = list(expressions[target])
    return normalized


def build(manifest: dict, src_dir: Path) -> tuple[Image.Image, dict]:
    target = manifest.get("target_cell", {})
    target_w, target_h = int(target.get("w", 320)), int(target.get("h", 340))
    master_cols = int(manifest.get("master_columns", 8))
    bg_thresh = int(manifest.get("bg_thresh", 55))
    checker_period = int(manifest.get("checker_period", 17))
    sheets = manifest.get("sheets", [])
    if not sheets:
        raise BuildError("manifest has no [[sheets]] entries")

    # Pass 1: gutter-slice every sheet, then bbox-crop so the shared-scale
    # step in Pass 2 sees just the character silhouette.
    raw_cells: list[Image.Image] = []
    records: list[dict] = []  # provenance per flat index

    for sheet_def in sheets:
        file_name = sheet_def["file"]
        cols, rows = int(sheet_def["cols"]), int(sheet_def["rows"])
        labels = sheet_def["labels"]
        if len(labels) != cols * rows:
            raise BuildError(
                f"{file_name}: {len(labels)} labels but grid is {cols}x{rows}={cols * rows}")
        src_path = src_dir / file_name
        if not src_path.is_file():
            raise BuildError(f"source sheet missing: {src_path}")
        with Image.open(src_path) as raw:
            sheet = raw.convert("RGBA")
        source_has_alpha = sheet.getchannel("A").getextrema()[0] < 250
        sliced = slice_sheet_raw(sheet, cols, rows, source_has_alpha,
                                 bg_thresh, checker_period)
        print(f"  {file_name}: {'true alpha' if source_has_alpha else 'baked background -> cut out'}")
        for src_index, (cell, label) in enumerate(zip(sliced, labels)):
            bbox = cell.getbbox()
            cropped = cell.crop(bbox) if bbox else cell
            records.append({"i": len(raw_cells), "label": label,
                             "sheet": file_name, "src": src_index})
            raw_cells.append(cropped)

    # Pass 1.5: measure each cell's bust width so we can pick a per-cell
    # scale that normalizes character body size across all expressions.
    bust_widths = [_measure_bust_width(c) for c in raw_cells]
    target_bust = round(target_w * TARGET_BUST_RATIO)
    per_cell_scales = [(target_bust / bw) if bw > 0 else 1.0 for bw in bust_widths]

    # Cap any per-cell scale that would push the cell over the frame height
    # (rare outliers: yawn, surprised_strong). Tall outliers stay tall but
    # do not exceed the frame.
    for i, c in enumerate(raw_cells):
        if c.height * per_cell_scales[i] + TOP_MARGIN > target_h:
            per_cell_scales[i] = (target_h - TOP_MARGIN) / c.height

    print(f"  target bust = {target_bust}, scale range = "
          f"{min(per_cell_scales):.4f}..{max(per_cell_scales):.4f}, "
          f"bust_w range = {min(bust_widths)}..{max(bust_widths)}")

    # Pass 2: place every cell with its OWN scale so the bust matches the
    # shared target. Top-anchored at TOP_MARGIN locks the crown height.
    packed = [place_cell_normalized(c, target_w, target_h, s, TOP_MARGIN)
              for c, s in zip(raw_cells, per_cell_scales)]

    count = len(packed)
    master_rows = math.ceil(count / master_cols)
    atlas = Image.new("RGBA", (master_cols * target_w, master_rows * target_h), (0, 0, 0, 0))
    for index, cell in enumerate(packed):
        col, row = index % master_cols, index // master_cols
        atlas.paste(cell, (col * target_w, row * target_h), cell)

    expressions: dict[str, list[int]] = {}
    for rec in records:
        expressions.setdefault(rec["label"], []).append(rec["i"])
    aliases = apply_aliases(expressions, manifest.get("aliases", {}))

    layout = {
        "version": 1,
        "cell": {"w": target_w, "h": target_h},
        "columns": master_cols,
        "rows": master_rows,
        "count": count,
        "expressions": expressions,
        "moods": manifest.get("moods", {}),
        "ambient": manifest.get("ambient", {}),
        "talking": manifest.get("talking", {}),
        "transitions": manifest.get("transitions", {}),
        "aliases": aliases,
        "cells": records,
    }
    _warn_unresolved(layout)
    return atlas, layout


def _warn_unresolved(layout: dict) -> None:
    """Print a warning for any label referenced in groupings but with no cells."""
    known = set(layout["expressions"])
    referenced: set[str] = set()
    for labels in layout["moods"].values():
        referenced.update(labels)
    for value in layout["ambient"].values():
        referenced.update([value] if isinstance(value, str) else value)
    talking = layout["talking"]
    for names in (talking.values() if isinstance(talking, dict) else [talking]):
        referenced.update(names)
    transitions = layout.get("transitions", {})
    if isinstance(transitions, dict):
        referenced.update(transitions.values())
    missing = sorted(referenced - known)
    if missing:
        print(f"  WARNING: labels referenced but not present in any sheet: {', '.join(missing)}")


def main() -> int:
    args = parse_args()
    src_dir = args.src_dir or args.manifest.parent
    try:
        manifest = load_manifest(args.manifest)
        atlas, layout = build(manifest, src_dir)
    except BuildError as error:
        print(f"ERROR: {error}")
        return 1

    args.out_sheet.parent.mkdir(parents=True, exist_ok=True)
    args.out_layout.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(args.out_sheet, format="WEBP", lossless=True, quality=100, method=6)
    args.out_layout.write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"atlas : {atlas.width}x{atlas.height}  {layout['count']} cells"
          f"  ({layout['columns']}x{layout['rows']} grid, cell {layout['cell']['w']}x{layout['cell']['h']})")
    print(f"        -> {args.out_sheet}")
    print(f"layout: {len(layout['expressions'])} distinct expressions")
    print(f"        -> {args.out_layout}")
    for label, indices in sorted(layout["expressions"].items()):
        print(f"  {label:16s} x{len(indices):2d}  {indices}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
