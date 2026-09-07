#!/usr/bin/env python3
"""Synchronize portable Claude skills and verify their content manifest."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "skills" / "claude"
NAMES = ("session-dispatch", "mycmux-bridge", "oracmux")
EXCLUDES = ("__pycache__", ".pytest_cache", "*.pyc", "*.bak*", "_backup*", "_prev", ".mycmux-pack.json")
VERSION = "1.0.0"
TEXT_EXTENSIONS = frozenset((".py", ".md", ".json", ".txt", ".yaml", ".yml",
                             ".sh", ".ps1", ".toml", ".cfg", ".ini"))

# Embedded in each standalone skill: installation never requires another skill
# merely to locate the CLI. Discovery is based on __file__, never the cwd.
RESOLVER = '''
def resolve_agent_cli() -> Path:
    import os
    import sys
    explicit = os.environ.get("MYCMUX_AGENT_CLI")
    candidates = [Path(explicit).expanduser()] if explicit else []
    candidates.append(Path.home() / ".mycmux" / "bin" / "mycmux_agent_cli.py")
    candidates.extend(parent / "scripts" / "mycmux_agent_cli.py"
                      for parent in Path(__file__).resolve().parents)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    print("mycmux agent CLI not found. From the mycmux checkout run: "
          "python scripts/install_claude_skills.py install", file=sys.stderr)
    raise SystemExit(7)

'''


def excluded(rel: Path) -> bool:
    return any(fnmatch.fnmatch(part, pattern) for part in rel.parts for pattern in EXCLUDES)


def files(root: Path) -> dict[str, bytes]:
    result = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if excluded(rel):
            continue
        if path.is_symlink():
            raise ValueError(f"symlink is not supported: {path}")
        if path.is_file():
            result[rel.as_posix()] = path.read_bytes()
    return result


def normalized_bytes(path: str | Path, data: bytes) -> bytes:
    """Canonical manifest/install bytes; non-text extensions stay byte-exact."""
    if Path(path).suffix.lower() in TEXT_EXTENSIONS:
        return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return data


def sha(data: bytes, path: str | Path) -> str:
    return hashlib.sha256(normalized_bytes(path, data)).hexdigest()


def hashes(items: dict[str, bytes]) -> dict[str, str]:
    return {name: sha(data, name) for name, data in sorted(items.items())}


def write(path: Path, data: bytes) -> bool:
    data = normalized_bytes(path, data)
    if path.is_file() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() in TEXT_EXTENSIONS:
        content = data.decode("utf-8")
        if content.startswith("\ufeff") or "\ufffd" in content:
            raise ValueError(f"text must be UTF-8 without BOM or replacement characters: {path}")
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        assert path.read_text(encoding="utf-8").count("\ufffd") == 0, path
    else:
        path.write_bytes(data)
    assert path.read_bytes() == data, path
    return True


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def replace_once(text: str, old: str, new: str) -> str:
    if old not in text:
        if new in text:
            return text
        raise ValueError(f"live source changed; review portable adaptation: {old[:70]}")
    return text.replace(old, new)


def portable(name: str, rel: str, data: bytes) -> tuple[str, bytes]:
    if Path(rel).suffix.lower() not in TEXT_EXTENSIONS:
        return rel, data
    text = normalized_bytes(rel, data).decode("utf-8-sig")
    if rel.endswith(".py"):
        text = text.replace("\ufffd", "\\ufffd")  # intentional invalid-text test fixture
    if name == "oracmux" and rel == "scripts/guard.json":
        cfg = json.loads(text)
        cfg["deny_roots"] = []
        return "scripts/guard.example.json", json_bytes(cfg)
    if rel.endswith(".py"):
        if name == "session-dispatch" and rel in ("scripts/dispatch_send.py", "scripts/dispatch_watch.py"):
            key = "AGENT_CLI" if rel.endswith("dispatch_send.py") else "CLOSE_CLI"
            text = re.sub(r'^' + key + r' = Path\(.*mycmux_agent_cli\.py.*\)$',
                          lambda _: RESOLVER + key + " = resolve_agent_cli()", text, flags=re.M)
            if key == "AGENT_CLI":
                text = re.sub(r'^BRIDGE_SCRIPT = Path\(.*\)$',
                              'BRIDGE_SCRIPT = Path(__file__).resolve().parents[2] / "mycmux-bridge" / "scripts" / "mycmux_bridge.py"', text, flags=re.M)
        elif name == "mycmux-bridge" and rel == "scripts/mycmux_bridge.py":
            text = re.sub(r'^KNOWN_REPO = .*\nREPO_ENV_VARS = .*\n', "", text, flags=re.M)
            start = text.find("def resolve_repo(")
            end = text.find("def load_agent_cli(", start)
            if start >= 0 and end >= 0:
                text = text[:start] + RESOLVER + text[end:]
            text = replace_once(text, '    path = repo / "scripts" / "mycmux_agent_cli.py"', '    path = repo  # already resolved CLI file')
            text = text.replace("repo = resolve_repo(args.repo)", "repo = resolve_agent_cli()")
            text = text.replace('    parser.add_argument("--repo", help="Fallback mycmux source checkout")\n', "")
        elif name == "oracmux" and rel == "scripts/oracmux_lib/paths.py":
            text = re.sub(r'^DEFAULT_MYCMUX_CLI = .*\n', lambda _: RESOLVER, text, flags=re.M)
            text = replace_once(text, '    return Path(value) if value else SCRIPTS_DIR / "guard.json"',
                                '    if value:\n        return Path(value).expanduser()\n    local = SCRIPTS_DIR / "guard.json"\n    return local if local.exists() else SCRIPTS_DIR / "guard.example.json"')
            text = replace_once(text, '    value = os.environ.get("MYCMUX_AGENT_CLI")\n    return Path(value) if value else DEFAULT_MYCMUX_CLI', '    return resolve_agent_cli()')
        elif name == "oracmux" and rel == "scripts/tests/conftest.py":
            line = '    monkeypatch.setenv("MYCMUX_AGENT_CLI", str(tmp_path / "mycmux_agent_cli.py"))'
            text = replace_once(text, line, line + '\n    (tmp_path / "mycmux_agent_cli.py").touch()') if '.touch()' not in text else text
    # Python regression fixtures retain Windows path syntax and escaping.
    if "/tests/" in rel:
        text = re.sub(r"Users([/\\]+)miyaz", lambda m: "Users" + m[1] + "example", text)
    else:
        text = text.replace("C:/Users/miyaz/cmux-for-linux-dev-master/scripts/mycmux_agent_cli.py", "<resolved-mycmux-agent-cli>")
        text = text.replace("C:/Users/miyaz/cmux-for-linux-dev-master/", "<mycmux-repository>/")
        text = text.replace("C:/Users/miyaz", "~").replace("C:\\Users\\miyaz", "~")
        if rel.endswith(".md"):
            text = re.sub(r'~\\[^`"\s]+', lambda m: m[0].replace("\\", "/"), text)
    if re.search(r"Users[/\\]+miyaz", text):
        raise ValueError(f"personal path remains: {name}/{rel}")
    return rel, text.encode("utf-8")


def live_view(root: Path, name: str) -> dict[str, bytes]:
    result = {}
    for rel, data in files(root).items():
        target, portable_data = portable(name, rel, data)
        if target in result and result[target] != portable_data:
            raise ValueError(f"conflicting live inputs: {name}/{target}")
        result[target] = portable_data
    return result


def manifest() -> dict:
    return {
        "pack_version": VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cli": {"path": "scripts/mycmux_agent_cli.py", "sha256": sha((ROOT / "scripts/mycmux_agent_cli.py").read_bytes(), "mycmux_agent_cli.py")},
        "skills": [{"name": name, "files": hashes(files(PACK / name))} for name in NAMES],
    }


def check_manifest() -> list[str]:
    stored = json.loads((PACK / "manifest.json").read_text(encoding="utf-8"))
    actual = manifest()
    errors = []
    for key in ("pack_version", "cli", "skills"):
        if stored.get(key) != actual[key]:
            errors.append(f"manifest mismatch: {key}")
    for path in PACK.rglob("*"):
        rel = path.relative_to(PACK)
        if excluded(rel):
            errors.append(f"excluded artifact in pack: {rel}")
        elif rel.parts[0] not in (*NAMES, "README.md", "manifest.json"):
            errors.append(f"unmanaged pack path: {rel}")
    return errors


def check_live(home: Path) -> list[str]:
    errors = []
    for name in NAMES:
        source = home / ".claude" / "skills" / name
        if not source.is_dir():
            print(f"SKIP live {name}: not installed")
            continue
        expected = hashes(live_view(source, name))
        actual = hashes(files(PACK / name))
        changed = sorted(key for key in expected.keys() | actual.keys() if expected.get(key) != actual.get(key))
        if changed:
            errors.append(f"live drift {name}: {', '.join(changed)}")
        else:
            print(f"OK live {name}: {len(expected)} files")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    direction = parser.add_mutually_exclusive_group()
    direction.add_argument("--from-live", action="store_true")
    direction.add_argument("--to-live", action="store_true", help="Maintainer-only: copy portable pack to live")
    parser.add_argument("--write-manifest", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--home", type=Path, default=Path.home())
    args = parser.parse_args(argv)
    if not any((args.from_live, args.to_live, args.write_manifest, args.check)):
        parser.error("select a sync, manifest, or check operation")
    try:
        plans = []
        for name in NAMES if args.from_live or args.to_live else ():
            live = args.home.expanduser() / ".claude" / "skills" / name
            source, dest = (live, PACK / name) if args.from_live else (PACK / name, live)
            if not source.is_dir():
                raise ValueError(f"source missing: {source}")
            incoming = live_view(source, name) if args.from_live else files(source)
            extra = set(files(dest)) - set(incoming)
            if args.to_live:
                extra.discard("scripts/guard.json")  # preserve user configuration
            if extra:
                raise ValueError(f"stale destination files require review: {dest}: {sorted(extra)}")
            plans.append((name, dest, incoming))
        for name, dest, incoming in plans:
            count = sum(write(dest / rel, data) for rel, data in incoming.items())
            print(f"SYNC {name}: {count} files changed")
        if args.write_manifest:
            value = manifest()
            path = PACK / "manifest.json"
            if path.exists():
                old = json.loads(path.read_text(encoding="utf-8"))
                if all(old.get(key) == value[key] for key in ("pack_version", "cli", "skills")):
                    value["generated_at"] = old["generated_at"]
            write(path, json_bytes(value))
            print("OK manifest written")
        if args.check:
            errors = check_manifest() + check_live(args.home.expanduser())
            for error in errors:
                print(f"ERROR {error}", file=sys.stderr)
            if errors:
                return 1
            print("OK pack manifest and live drift")
    except (OSError, ValueError, KeyError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
