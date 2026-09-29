#!/usr/bin/env python3
"""Normalize a Tauri updater feed without platform-specific dependencies."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict


class NormalizationError(ValueError):
    """Raised when a feed cannot be normalized safely."""


def normalize_feed(feed: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy with the Windows fallback pointing at the NSIS entry.

    Darwin and any future platform entries are deliberately preserved verbatim.
    """
    normalized = copy.deepcopy(feed)
    platforms = normalized.get("platforms")
    if not isinstance(platforms, dict):
        raise NormalizationError(
            "latest.json has no 'platforms' object; cannot normalize fallback key."
        )

    nsis_entry = platforms.get("windows-x86_64-nsis")
    if not isinstance(nsis_entry, dict):
        raise NormalizationError(
            "latest.json has no 'windows-x86_64-nsis' platform entry; "
            "cannot normalize fallback key."
        )
    if not nsis_entry.get("signature") or not nsis_entry.get("url"):
        raise NormalizationError(
            "latest.json 'windows-x86_64-nsis' entry needs signature and url."
        )

    platforms["windows-x86_64"] = copy.deepcopy(nsis_entry)
    return normalized


def normalize_file(input_path: Path, output_path: Path) -> None:
    """Normalize one JSON file and write UTF-8 JSON to the requested path."""
    if not input_path.is_file():
        raise NormalizationError(f"Input latest.json not found: {input_path}")
    feed = json.loads(input_path.read_text(encoding="utf-8-sig"))
    normalized = normalize_feed(feed)
    output_path.write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="input latest.json")
    parser.add_argument("--output", type=Path, help="output path; defaults to input")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the platform-neutral normalizer CLI."""
    args = build_parser().parse_args(argv)
    output_path = args.output or args.input
    try:
        normalize_file(args.input, output_path)
    except (NormalizationError, OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(
        f"Normalized '{args.input}' -> '{output_path}': "
        "windows-x86_64 now matches windows-x86_64-nsis."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
