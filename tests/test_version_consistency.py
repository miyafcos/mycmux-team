"""Contract test asserting that mycmux-lite's version is the same everywhere
it is declared.

Adapted from master's test_version_consistency.py (which guards against the
0.8.54 incident where package-lock.json was frozen at an old version for
three releases while package.json moved on -- `npm ci` doesn't fail on a
stale lockfile version field, so the drift went unnoticed until it was
caught by hand). Five sources of truth are checked: package.json,
package-lock.json (both the root `.version` and `packages[""].version`),
src-tauri/tauri.conf.json, src-tauri/Cargo.toml, and the `mycmux-lite` entry
in src-tauri/Cargo.lock (lite's crate/package name, unlike master's
`mycmux`).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_package_json_version() -> str:
    return read_json(REPO_ROOT / "package.json")["version"]


def read_package_lock_versions() -> tuple[str, str]:
    data = read_json(REPO_ROOT / "package-lock.json")
    root_version = data["version"]
    root_package_version = data["packages"][""]["version"]
    return root_version, root_package_version


def read_tauri_conf_version() -> str:
    return read_json(REPO_ROOT / "src-tauri" / "tauri.conf.json")["version"]


def read_cargo_toml_version() -> str:
    text = (REPO_ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    package_section = re.search(r"\[package\](?P<body>.*?)(?:\n\[|\Z)", text, re.DOTALL)
    assert package_section is not None, "Cargo.toml has no [package] section"
    match = re.search(r'^version\s*=\s*"([^"]+)"', package_section.group("body"), re.MULTILINE)
    assert match is not None, "Cargo.toml [package] section has no version field"
    return match.group(1)


def read_cargo_lock_mycmux_version() -> str:
    text = (REPO_ROOT / "src-tauri" / "Cargo.lock").read_text(encoding="utf-8")
    match = re.search(r'name = "mycmux-lite"\nversion = "([^"]+)"', text)
    assert match is not None, "Cargo.lock has no 'mycmux-lite' package entry"
    return match.group(1)


def test_version_is_consistent_across_all_manifests() -> None:
    package_json_version = read_package_json_version()
    lock_root_version, lock_package_version = read_package_lock_versions()
    tauri_conf_version = read_tauri_conf_version()
    cargo_toml_version = read_cargo_toml_version()
    cargo_lock_version = read_cargo_lock_mycmux_version()

    versions = {
        "package.json .version": package_json_version,
        "package-lock.json .version": lock_root_version,
        'package-lock.json packages[""].version': lock_package_version,
        "src-tauri/tauri.conf.json .version": tauri_conf_version,
        "src-tauri/Cargo.toml [package].version": cargo_toml_version,
        "src-tauri/Cargo.lock mycmux-lite version": cargo_lock_version,
    }

    distinct = set(versions.values())
    assert len(distinct) == 1, (
        "Version mismatch across manifests -- update all of them before tagging a release:\n"
        + "\n".join(f"  {name}: {value}" for name, value in versions.items())
    )
