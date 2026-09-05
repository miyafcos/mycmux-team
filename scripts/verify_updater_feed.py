#!/usr/bin/env python3
"""Verify the published mycmux updater feed against the shipped public key.

Why this exists: on 2026-08-05 CI shipped v0.21.16 signed with a rotated-away
key (GitHub Secrets still held the old one). The feed advertised the right
*version*, so every version-only check passed, while the in-app update button
failed for users with a signature verification error. This script closes that
gap by comparing the minisign key-id embedded in EVERY platforms[] signature
against the key-id embedded in plugins.updater.pubkey from tauri.conf.json.

Both key-ids are derived through the same function (`extract_key_id`), so the
byte order can never diverge between the two sides of the comparison.

Usage:
    python scripts/verify_updater_feed.py --expect-version 0.21.29
    python scripts/verify_updater_feed.py --expect-local
    python scripts/verify_updater_feed.py --expect-local --file latest.json
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = REPO_ROOT / "src-tauri" / "tauri.conf.json"
DEFAULT_FEED_URL = (
    "https://github.com/miyafcos/mycmux-team/releases/download/"
    "mycmux-personal-updater/latest.json"
)
_COMMENT_PREFIXES = ("untrusted comment:", "trusted comment:")
REQUIRED_PLATFORMS = {
    "windows-x86_64",
    "windows-x86_64-msi",
    "windows-x86_64-nsis",
    "darwin-aarch64",
}


class VerificationError(Exception):
    """Raised when the feed cannot be parsed or fails a contract check."""


def extract_key_id(blob_b64: str) -> str:
    """Return the minisign key-id (lowercase hex) of a base64 minisign blob.

    Handles both sides of the comparison identically: a tauri `pubkey` value
    and a feed `signature` value are both base64 of a whole minisign file
    (comment lines plus base64 payload lines). The first non-comment line is
    the key/signature payload; its raw bytes are 2 algorithm bytes followed by
    the 8-byte key-id.
    """
    if not isinstance(blob_b64, str) or not blob_b64.strip():
        raise VerificationError("minisign blob is empty")

    try:
        text = base64.b64decode(blob_b64.strip(), validate=False).decode("utf-8")
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise VerificationError(f"minisign blob is not base64-encoded text: {exc}") from exc

    payload_line = ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.lower().startswith(_COMMENT_PREFIXES):
            continue
        payload_line = stripped
        break
    if not payload_line:
        raise VerificationError("minisign blob has no payload line (only comments)")

    try:
        raw = base64.b64decode(payload_line, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise VerificationError(f"minisign payload line is not valid base64: {exc}") from exc
    if len(raw) < 10:
        raise VerificationError(
            f"minisign payload is too short for a key-id ({len(raw)} bytes, need >= 10)"
        )
    return raw[2:10].hex()


def load_config(config_path: Path = CONFIG_PATH) -> Dict[str, Any]:
    return json.loads(config_path.read_text(encoding="utf-8"))


def config_pubkey_key_id(config: Dict[str, Any]) -> str:
    pubkey = config.get("plugins", {}).get("updater", {}).get("pubkey", "")
    if not pubkey:
        raise VerificationError("tauri.conf.json has no plugins.updater.pubkey")
    return extract_key_id(pubkey)


def fetch_feed(url: str, timeout: float) -> Dict[str, Any]:
    # Cache-bust: GitHub's release asset CDN happily serves a stale latest.json
    # right after a mirror push, which would verify the previous release.
    request = urllib.request.Request(
        f"{url}?cacheBust={uuid.uuid4().hex}",
        headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def verify_feed(feed: Dict[str, Any], expected_version: str, expected_key_id: str) -> bool:
    """Print a PASS/FAIL report; return True when every check passed."""
    failures = []

    feed_version = str(feed.get("version", ""))
    if feed_version == expected_version:
        print(f"PASS version: {feed_version}")
    else:
        failures.append(f"version mismatch: feed={feed_version!r} expected={expected_version!r}")

    platforms = feed.get("platforms")
    if not isinstance(platforms, dict) or not platforms:
        failures.append("feed has no platforms[] entries")
        platforms = {}

    missing_platforms = REQUIRED_PLATFORMS - set(platforms)
    if missing_platforms:
        failures.append(
            "feed is missing required platform entries: "
            + ", ".join(sorted(missing_platforms))
        )

    print(f"expected key-id (tauri.conf.json pubkey): {expected_key_id}")
    for name in sorted(platforms):
        entry = platforms[name] or {}
        try:
            key_id = extract_key_id(entry.get("signature", ""))
        except VerificationError as exc:
            failures.append(f"{name}: unreadable signature ({exc})")
            continue
        if key_id == expected_key_id:
            print(f"PASS {name}: key-id {key_id}")
        else:
            failures.append(f"{name}: key-id {key_id} != expected {expected_key_id}")

    if failures:
        print("")
        for failure in failures:
            print(f"FAIL {failure}")
        print("")
        print(
            f"FAIL updater feed verification ({len(failures)} problem(s)). "
            "A key-id mismatch means the in-app update button will fail with a "
            "signature verification error (see the v0.21.16 incident)."
        )
        return False

    print("")
    print("PASS updater feed verification")
    return True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--expect-version", help="version string the feed must advertise")
    group.add_argument(
        "--expect-local",
        action="store_true",
        help="expect the version currently in src-tauri/tauri.conf.json",
    )
    parser.add_argument("--file", help="check a local latest.json instead of fetching (offline)")
    parser.add_argument("--url", default=DEFAULT_FEED_URL, help="feed URL to fetch")
    parser.add_argument("--timeout", type=float, default=30.0, help="fetch timeout in seconds")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        config = load_config()
        expected_key_id = config_pubkey_key_id(config)
        expected_version = args.expect_version or str(config.get("version", ""))
        if not expected_version:
            raise VerificationError("no expected version (tauri.conf.json has no version)")

        if args.file:
            feed = json.loads(Path(args.file).read_text(encoding="utf-8"))
            print(f"source: {args.file}")
        else:
            feed = fetch_feed(args.url, args.timeout)
            print(f"source: {args.url}")
    except (VerificationError, OSError, json.JSONDecodeError, urllib.error.URLError) as exc:
        print(f"FAIL could not verify the updater feed: {exc}")
        return 1

    return 0 if verify_feed(feed, expected_version, expected_key_id) else 1


if __name__ == "__main__":
    sys.exit(main())
