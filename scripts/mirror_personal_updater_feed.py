#!/usr/bin/env python3
"""Mirror Windows and Apple Silicon updater assets into the public feed release."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Sequence
from urllib.parse import quote

from normalize_updater_feed import normalize_feed


@dataclass(frozen=True)
class ReleaseAsset:
    """A release asset selected for the combined updater feed."""

    name: str
    path: Path


ASSET_PATTERNS = {
    "windows_nsis": re.compile(r"^mycmux_.*_x64-setup\.exe$"),
    "windows_nsis_sig": re.compile(r"^mycmux_.*_x64-setup\.exe\.sig$"),
    "windows_msi": re.compile(r"^mycmux_.*_x64_en-US\.msi$"),
    "windows_msi_sig": re.compile(r"^mycmux_.*_x64_en-US\.msi\.sig$"),
    "macos_dmg": re.compile(r"^mycmux_.*_aarch64\.dmg$"),
    "macos_updater": re.compile(r"^mycmux\.app\.tar\.gz$", re.IGNORECASE),
    "macos_updater_sig": re.compile(r"^mycmux\.app\.tar\.gz\.sig$", re.IGNORECASE),
}


class MirrorError(RuntimeError):
    """Raised when release assets do not satisfy the updater contract."""


def run_gh(arguments: Sequence[str], capture: bool = False) -> str:
    """Run GitHub CLI and fail with the original diagnostics visible."""
    command = ["gh", *arguments]
    result = subprocess.run(command, text=True, capture_output=capture)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise MirrorError(
            f"{' '.join(command)} failed with exit code {result.returncode}: {detail}"
        )
    return result.stdout if capture else ""


def select_asset_names(asset_names: Sequence[str]) -> Dict[str, str]:
    """Select exactly one required release asset for every supported bundle."""
    selected: Dict[str, str] = {}
    for kind, pattern in ASSET_PATTERNS.items():
        matches = sorted(name for name in asset_names if pattern.fullmatch(name))
        if len(matches) != 1:
            raise MirrorError(
                f"expected exactly one {kind} asset matching {pattern.pattern!r}; "
                f"found {len(matches)}: {matches}"
            )
        selected[kind] = matches[0]
    return selected


def read_signature(path: Path) -> str:
    """Read one non-empty Tauri updater signature."""
    signature = path.read_text(encoding="utf-8").strip()
    if not signature:
        raise MirrorError(f"updater signature is empty: {path}")
    return signature


def asset_url(repo: str, tag: str, asset_name: str) -> str:
    """Build the stable GitHub release download URL for one mirrored asset."""
    return (
        f"https://github.com/{repo}/releases/download/{quote(tag, safe='')}/"
        f"{quote(asset_name)}"
    )


def build_feed(
    *,
    version: str,
    source_tag: str,
    target_repo: str,
    target_tag: str,
    published_at: str,
    selected: Dict[str, str],
    signatures: Dict[str, str],
) -> Dict[str, Any]:
    """Build a combined Windows and darwin-aarch64 static updater feed."""
    nsis_entry = {
        "signature": signatures["windows_nsis_sig"],
        "url": asset_url(target_repo, target_tag, selected["windows_nsis"]),
    }
    feed: Dict[str, Any] = {
        "version": version,
        "notes": f"mycmux personal build ({source_tag}). See CHANGELOG.md for details.",
        "pub_date": published_at,
        "platforms": {
            "windows-x86_64": nsis_entry,
            "windows-x86_64-msi": {
                "signature": signatures["windows_msi_sig"],
                "url": asset_url(target_repo, target_tag, selected["windows_msi"]),
            },
            "windows-x86_64-nsis": nsis_entry,
            "darwin-aarch64": {
                "signature": signatures["macos_updater_sig"],
                "url": asset_url(target_repo, target_tag, selected["macos_updater"]),
            },
        },
    }
    return normalize_feed(feed)


def load_source_release(source_repo: str, source_tag: str) -> Dict[str, Any]:
    """Load source release metadata through GitHub CLI."""
    raw = run_gh(
        [
            "release",
            "view",
            source_tag,
            "--repo",
            source_repo,
            "--json",
            "assets,publishedAt,createdAt",
        ],
        capture=True,
    )
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise MirrorError("gh release view returned a non-object payload")
    return data


def ensure_target_release(target_repo: str, target_tag: str) -> None:
    """Create or normalize the fixed public updater release."""
    result = subprocess.run(
        ["gh", "release", "view", target_tag, "--repo", target_repo],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode == 0:
        run_gh(
            [
                "release",
                "edit",
                target_tag,
                "--repo",
                target_repo,
                "--title",
                "mycmux personal updater feed",
                "--prerelease",
                "--latest=false",
            ]
        )
        return
    run_gh(
        [
            "release",
            "create",
            target_tag,
            "--repo",
            target_repo,
            "--title",
            "mycmux personal updater feed",
            "--notes",
            "Fixed public updater feed for mycmux personal builds.",
            "--prerelease",
            "--latest=false",
        ]
    )


def mirror_release(
    *,
    source_tag: str,
    source_repo: str,
    target_repo: str,
    target_tag: str,
    work_dir: Path,
) -> None:
    """Mirror required assets, generate the combined feed, and verify publication."""
    release = load_source_release(source_repo, source_tag)
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise MirrorError("source release has no assets list")
    asset_names = [asset.get("name", "") for asset in assets if isinstance(asset, dict)]
    selected = select_asset_names(asset_names)

    work_dir.mkdir(parents=True, exist_ok=True)
    downloaded: Dict[str, ReleaseAsset] = {}
    for kind, name in selected.items():
        run_gh(
            [
                "release",
                "download",
                source_tag,
                "--repo",
                source_repo,
                "--dir",
                str(work_dir),
                "--pattern",
                name,
                "--clobber",
            ]
        )
        path = work_dir / name
        if not path.is_file():
            raise MirrorError(f"downloaded asset not found: {path}")
        downloaded[kind] = ReleaseAsset(name=name, path=path)

    version = source_tag[1:] if source_tag.startswith("v") else source_tag
    published_at = str(release.get("publishedAt") or release.get("createdAt") or "")
    if not published_at:
        raise MirrorError("source release has no publishedAt or createdAt timestamp")
    signatures = {
        kind: read_signature(downloaded[kind].path)
        for kind in ("windows_nsis_sig", "windows_msi_sig", "macos_updater_sig")
    }
    feed = build_feed(
        version=version,
        source_tag=source_tag,
        target_repo=target_repo,
        target_tag=target_tag,
        published_at=published_at,
        selected=selected,
        signatures=signatures,
    )
    latest_path = work_dir / "latest.json"
    latest_path.write_text(
        json.dumps(feed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    ensure_target_release(target_repo, target_tag)
    upload_paths = [latest_path, *(asset.path for asset in downloaded.values())]
    run_gh(
        [
            "release",
            "upload",
            target_tag,
            *(str(path) for path in upload_paths),
            "--repo",
            target_repo,
            "--clobber",
        ]
    )

    verify_dir = work_dir / "verify"
    verify_dir.mkdir(exist_ok=True)
    run_gh(
        [
            "release",
            "download",
            target_tag,
            "--repo",
            target_repo,
            "--dir",
            str(verify_dir),
            "--pattern",
            "latest.json",
            "--clobber",
        ]
    )
    published = json.loads((verify_dir / "latest.json").read_text(encoding="utf-8"))
    if published.get("version") != version:
        raise MirrorError(
            f"published latest.json version {published.get('version')!r} "
            f"does not match expected {version!r}"
        )
    missing = {
        "windows-x86_64",
        "windows-x86_64-msi",
        "windows-x86_64-nsis",
        "darwin-aarch64",
    } - set(published.get("platforms", {}))
    if missing:
        raise MirrorError(f"published latest.json is missing platforms: {sorted(missing)}")


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-tag", required=True)
    parser.add_argument("--source-repo", default="miyafcos/mycmux")
    parser.add_argument("--target-repo", default="miyafcos/mycmux-team")
    parser.add_argument("--target-tag", default="mycmux-personal-updater")
    parser.add_argument("--work-dir", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the cross-platform release mirror."""
    args = build_parser().parse_args(argv)
    try:
        if args.work_dir:
            mirror_release(
                source_tag=args.source_tag,
                source_repo=args.source_repo,
                target_repo=args.target_repo,
                target_tag=args.target_tag,
                work_dir=args.work_dir,
            )
        else:
            with tempfile.TemporaryDirectory(prefix="mycmux-personal-updater-") as temp:
                mirror_release(
                    source_tag=args.source_tag,
                    source_repo=args.source_repo,
                    target_repo=args.target_repo,
                    target_tag=args.target_tag,
                    work_dir=Path(temp),
                )
    except (MirrorError, OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(
        f"Mirrored {args.source_repo} {args.source_tag} to "
        f"{args.target_repo} {args.target_tag}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
