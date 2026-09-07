"""Content, portability, drift, and real isolated installation contracts."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "skills" / "claude"
NAMES = ("session-dispatch", "mycmux-bridge", "oracmux")
spec = importlib.util.spec_from_file_location("skillpack_sync", ROOT / "scripts/sync_claude_skills.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    return subprocess.run([sys.executable, *map(str, args)], cwd=ROOT, env=env,
                          capture_output=True, text=True, encoding="utf-8", timeout=45)


def install(home, *args):
    return run("scripts/install_claude_skills.py", "install", "--home", home, *args)


def test_manifest_covers_exact_files_and_cli():
    manifest = json.loads((PACK / "manifest.json").read_text(encoding="utf-8"))
    assert [item["name"] for item in manifest["skills"]] == list(NAMES)
    assert manifest["pack_version"] and manifest["generated_at"]
    for item in manifest["skills"]:
        actual = {p.relative_to(PACK / item["name"]).as_posix(): sync.sha(p.read_bytes(), p)
                  for p in (PACK / item["name"]).rglob("*") if p.is_file()}
        assert actual == item["files"]
    assert manifest["cli"]["path"] == "scripts/mycmux_agent_cli.py"
    cli = ROOT / manifest["cli"]["path"]
    assert manifest["cli"]["sha256"] == sync.sha(cli.read_bytes(), cli)
    assert sync.check_manifest() == []


def test_no_excluded_or_personal_content_and_utf8_lf():
    for path in PACK.rglob("*"):
        assert not sync.excluded(path.relative_to(PACK)), path
        if path.is_file():
            data = path.read_bytes()
            assert not data.startswith(b"\xef\xbb\xbf") and b"\r" not in data, path
            text = data.decode("utf-8")
            assert "\ufffd" not in text, path
            assert not re.search(r"Users[/\\]+miyaz", text), path


def test_pack_text_files_are_lf_only():
    for path in PACK.rglob("*"):
        if path.is_file() and path.suffix.lower() in sync.TEXT_EXTENSIONS:
            assert b"\r" not in path.read_bytes(), path


def as_crlf(data: bytes) -> bytes:
    """A CRLF working copy of `data`, whatever line endings it has now.

    A checkout that predates .gitattributes still holds CRLF copies of the CLI;
    turning "\\n" into "\\r\\n" blindly on those made "\\r\\r\\n" and a bogus
    mismatch (v0.65.0 release run, 2026-09-07).
    """
    return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def test_manifest_sha_uses_lf_normalization():
    manifest = json.loads((PACK / "manifest.json").read_text(encoding="utf-8"))
    for item in manifest["skills"]:
        for rel, expected in item["files"].items():
            path = PACK / item["name"] / rel
            data = path.read_bytes()
            assert sync.sha(data, path) == expected
            if path.suffix.lower() in sync.TEXT_EXTENSIONS:
                assert sync.sha(as_crlf(data), path) == expected
    cli = ROOT / manifest["cli"]["path"]
    assert sync.sha(as_crlf(cli.read_bytes()), cli) == manifest["cli"]["sha256"]


def test_normalization_extension_contract_and_binary_write(tmp_path):
    text_extensions = (".py", ".md", ".json", ".txt", ".yaml", ".yml",
                       ".sh", ".ps1", ".toml", ".cfg", ".ini")
    assert sync.TEXT_EXTENSIONS == frozenset(text_extensions)
    for extension in text_extensions:
        path = tmp_path / ("fixture" + extension.upper())
        assert sync.sha(b"a\r\nb\rc\n", path) == hashlib.sha256(b"a\nb\nc\n").hexdigest()
        assert sync.write(path, b"a\r\nb\rc\n")
        assert path.read_bytes() == b"a\nb\nc\n"
    binary = b"\x00\xff\r\n\r\n"
    path = tmp_path / "fixture.bin"
    assert sync.sha(binary, path) == hashlib.sha256(binary).hexdigest()
    assert sync.portable("oracmux", path.name, binary) == (path.name, binary)
    assert sync.write(path, binary)
    assert path.read_bytes() == binary


def test_crlf_checkout_installs_lf_and_ignores_editor_newline_changes(tmp_path):
    checkout = tmp_path / "CRLF checkout"
    shutil.copytree(PACK, checkout / "skills/claude")
    (checkout / "scripts").mkdir()
    for name in ("sync_claude_skills.py", "install_claude_skills.py", "mycmux_agent_cli.py"):
        shutil.copyfile(ROOT / "scripts" / name, checkout / "scripts" / name)
    for path in checkout.rglob("*"):
        if path.is_file() and path.suffix.lower() in sync.TEXT_EXTENSIONS:
            path.write_bytes(sync.normalized_bytes(path, path.read_bytes()).replace(b"\n", b"\r\n"))
    home = tmp_path / "installed home"
    installer = checkout / "scripts/install_claude_skills.py"
    result = run(checkout / "scripts/sync_claude_skills.py", "--check", "--home", tmp_path / "no-live")
    assert result.returncode == 0, result.stderr
    result = run(installer, "install", "--home", home)
    assert result.returncode == 0, result.stderr
    installed = [p for p in home.rglob("*") if p.is_file()]
    assert all(b"\r" not in p.read_bytes() for p in installed)
    for path in installed:
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
    assert run(installer, "check", "--home", home).returncode == 0
    result = run(installer, "install", "--home", home)
    assert result.returncode == 0 and result.stdout.count("NORMALIZE") == 4, result.stderr
    assert all(b"\r" not in p.read_bytes() for p in installed)


@pytest.mark.parametrize("name", NAMES)
def test_frontmatter(name):
    text = (PACK / name / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---\n")
    header = text.split("---", 2)[1]
    match = re.search(r"^name:\s*['\"]?([^'\"\n]+)", header, re.M)
    assert match and match[1].strip() == name


def test_install_noop_local_edit_force_and_check(tmp_path):
    home = tmp_path / "home with spaces"
    result = install(home)
    assert result.returncode == 0, result.stderr
    files = [p for p in home.rglob("*") if p.is_file()]
    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in files}
    result = install(home)
    assert result.returncode == 0 and result.stdout.count("SKIP") == 4, result.stderr
    assert before == {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in files}
    assert run("scripts/install_claude_skills.py", "check", "--home", home).returncode == 0
    edited = home / ".claude/skills/oracmux/SKILL.md"
    edited.write_bytes(edited.read_bytes() + b"\nlocal edit\n")
    result = install(home)
    assert result.returncode == 1 and "--force" in result.stderr
    assert edited.read_bytes().endswith(b"local edit\n")
    assert run("scripts/install_claude_skills.py", "check", "--home", home).returncode == 1
    assert install(home, "--force").returncode == 0
    assert list(edited.parent.parent.glob("oracmux.bak-*"))
    assert run("scripts/install_claude_skills.py", "check", "--home", home).returncode == 0


def test_unmanaged_folder_extra_file_and_selection(tmp_path):
    dest = tmp_path / ".claude/skills/mycmux-bridge"
    dest.mkdir(parents=True)
    (dest / "custom.md").write_bytes(b"keep me")
    assert install(tmp_path).returncode == 1
    assert not (tmp_path / ".claude/skills/session-dispatch").exists()
    assert install(tmp_path, "--skills", "mycmux-bridge", "--force").returncode == 0
    assert not (tmp_path / ".claude/skills/session-dispatch").exists()
    (dest / "extra.py").write_bytes(b"extra = True\n")
    assert install(tmp_path, "--skills", "mycmux-bridge").returncode == 1
    assert install(tmp_path, "--skills", "../outside").returncode == 2


def test_outdated_marker_updates_without_force(tmp_path):
    assert install(tmp_path).returncode == 0
    marker = tmp_path / ".claude/skills/oracmux/.mycmux-pack.json"
    data = json.loads(marker.read_text(encoding="utf-8"))
    data["pack_version"] = "0.0.1"
    with open(marker, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle)
    result = run("scripts/install_claude_skills.py", "check", "--home", tmp_path)
    assert result.returncode == 1 and "outdated" in result.stdout
    assert install(tmp_path).returncode == 0


@pytest.mark.parametrize("name", NAMES)
def test_live_drift_when_present(name):
    source = Path.home() / ".claude/skills" / name
    if not source.is_dir():
        pytest.skip(f"live {name}: not installed at {source}")
    assert sync.hashes(sync.live_view(source, name)) == sync.hashes(sync.files(PACK / name))


@pytest.mark.parametrize("relative", [
    "session-dispatch/scripts/dispatch_send.py",
    "session-dispatch/scripts/dispatch_watch.py",
    "mycmux-bridge/scripts/mycmux_bridge.py",
    "oracmux/scripts/oracmux_lib/paths.py",
])
def test_resolver_priority_and_missing_exit7(tmp_path, monkeypatch, capsys, relative):
    text = (PACK / relative).read_text(encoding="utf-8")
    assert sync.RESOLVER.strip() in text
    repo = tmp_path / "repo"
    script = repo / "skills/claude/example/scripts/tool.py"
    script.parent.mkdir(parents=True)
    cli = repo / "scripts/mycmux_agent_cli.py"
    cli.parent.mkdir()
    cli.touch()
    home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.delenv("MYCMUX_AGENT_CLI", raising=False)
    scope = {"Path": Path, "__file__": str(script)}
    exec(sync.RESOLVER, scope)
    resolve = scope["resolve_agent_cli"]
    assert resolve() == cli
    installed = home / ".mycmux/bin/mycmux_agent_cli.py"
    installed.parent.mkdir(parents=True)
    installed.touch()
    assert resolve() == installed
    explicit = tmp_path / "explicit.py"
    explicit.touch()
    monkeypatch.setenv("MYCMUX_AGENT_CLI", str(explicit))
    assert resolve() == explicit
    explicit.rename(explicit.with_suffix(".old"))
    installed.rename(installed.with_suffix(".old"))
    cli.rename(cli.with_suffix(".old"))
    with pytest.raises(SystemExit) as error:
        resolve()
    assert error.value.code == 7
    assert "python scripts/install_claude_skills.py install" in capsys.readouterr().err


def test_sync_roundtrip_and_stale_destination_refusal(tmp_path):
    for name in NAMES:
        # Portable transformation must be idempotent for --to-live round trips.
        original = sync.files(PACK / name)
        repeated = dict(sync.portable(name, rel, data) for rel, data in original.items())
        assert original == repeated
    result = run("scripts/sync_claude_skills.py", "--to-live", "--home", tmp_path)
    assert result.returncode == 0, result.stderr
    assert sync.check_live(tmp_path) == []
    extra = tmp_path / ".claude/skills/oracmux/extra.md"
    extra.write_bytes(b"do not remove\n")
    result = run("scripts/sync_claude_skills.py", "--to-live", "--home", tmp_path)
    assert result.returncode == 1 and "stale destination" in result.stderr
    assert extra.read_bytes() == b"do not remove\n"
