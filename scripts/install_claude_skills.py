#!/usr/bin/env python3
"""Install and inspect the repository's Claude skills without extra packages."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
import sync_claude_skills as pack

MARKER = ".mycmux-pack.json"


def state(dest: Path, entry: dict, version: str) -> str:
    if not dest.exists():
        return "not-installed"
    try:
        marker = json.loads((dest / MARKER).read_text(encoding="utf-8"))
        actual = pack.hashes(pack.files(dest))
        if actual != marker.get("sha256"):
            return "locally-modified"
        if actual == entry["files"] and marker.get("pack_version") == version:
            return "latest"
        return "outdated"
    except (OSError, ValueError, TypeError, AttributeError):
        return "locally-modified"


def backup_path(path: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return path.with_name(path.name + ".bak-" + stamp)


def install(home: Path, entries: list[dict], manifest: dict, force: bool) -> int:
    plans = [(entry, home / ".claude" / "skills" / entry["name"]) for entry in entries]
    # Preflight every selected skill before making any changes, including CLI.
    for entry, dest in plans:
        if dest.is_symlink():
            raise ValueError(f"symlink destination is not supported: {dest}")
        if state(dest, entry, manifest["pack_version"]) == "locally-modified" and not force:
            raise ValueError(f"{entry['name']}: local changes; inspect them, then use --force to replace (backup retained)")
    cli_dest = home / ".mycmux" / "bin" / "mycmux_agent_cli.py"
    if cli_dest.is_symlink():
        raise ValueError(f"symlink destination is not supported: {cli_dest}")
    for entry, dest in plans:
        status = state(dest, entry, manifest["pack_version"])
        if status == "latest":
            count = sum(pack.write(dest / rel, data)
                        for rel, data in pack.files(pack.PACK / entry["name"]).items())
            count += pack.write(dest / MARKER, (dest / MARKER).read_bytes())
            print(f"{'NORMALIZE' if count else 'SKIP'} {entry['name']}: latest")
            continue
        if dest.exists():
            backup = backup_path(dest)
            dest.rename(backup)
            print(f"BACKUP {dest.name}: {backup.name}")
        for rel, data in pack.files(pack.PACK / entry["name"]).items():
            pack.write(dest / rel, data)
        pack.write(dest / MARKER, pack.json_bytes({
            "pack_version": manifest["pack_version"],
            "sha256": entry["files"],
            "installed_at": datetime.now(timezone.utc).isoformat(),
        }))
        print(f"INSTALL {entry['name']}: {len(entry['files'])} files")
    cli_data = pack.normalized_bytes(cli_dest, (pack.ROOT / manifest["cli"]["path"]).read_bytes())
    if cli_dest.is_file() and pack.sha(cli_dest.read_bytes(), cli_dest) == manifest["cli"]["sha256"]:
        changed = pack.write(cli_dest, cli_data)
        print(f"{'NORMALIZE' if changed else 'SKIP'} CLI: latest")
    else:
        if cli_dest.exists():
            cli_dest.rename(backup_path(cli_dest))
        pack.write(cli_dest, cli_data)
        assert pack.sha(cli_dest.read_bytes(), cli_dest) == manifest["cli"]["sha256"]
        print("INSTALL CLI")
    return 0


def check(home: Path, entries: list[dict], manifest: dict) -> int:
    print("skill                 state")
    statuses = []
    for entry in entries:
        status = state(home / ".claude" / "skills" / entry["name"], entry, manifest["pack_version"])
        statuses.append(status)
        print(f"{entry['name']:<21} {status}")
    cli = home / ".mycmux" / "bin" / "mycmux_agent_cli.py"
    status = "not-installed" if not cli.is_file() else (
        "latest" if pack.sha(cli.read_bytes(), cli) == manifest["cli"]["sha256"] else "outdated")
    statuses.append(status)
    print(f"{'agent CLI':<21} {status}")
    return int(any(status != "latest" for status in statuses))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("install", "check"):
        child = sub.add_parser(command)
        child.add_argument("--home", type=Path, default=Path.home())
        child.add_argument("--skills", help="Comma-separated skill names (default: all three)")
        if command == "install":
            child.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    names = args.skills.split(",") if args.skills else list(pack.NAMES)
    if len(set(names)) != len(names) or any(name not in pack.NAMES for name in names):
        parser.error("--skills must contain unique names from: " + ",".join(pack.NAMES))
    try:
        errors = pack.check_manifest()
        if errors:
            raise ValueError("; ".join(errors))
        manifest = json.loads((pack.PACK / "manifest.json").read_text(encoding="utf-8"))
        entries = [entry for entry in manifest["skills"] if entry["name"] in names]
        home = args.home.expanduser().resolve()
        if args.command == "check":
            return check(home, entries, manifest)
        return install(home, entries, manifest, args.force)
    except (OSError, ValueError, KeyError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
