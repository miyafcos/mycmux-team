from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/mycmux_agent_cli.py"
spec = importlib.util.spec_from_file_location("inbox_cli", SCRIPT)
cli = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(cli)


@pytest.fixture
def inbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(tmp_path)
    runtime = tmp_path / "profile"
    monkeypatch.setenv("MYCMUX_RUNTIME_DIR", str(runtime))
    source = tmp_path / "report.md"
    source.write_bytes("# \u5165\u8a66\u5236\u5ea6\n<script>alert(1)</script>\n".encode("utf-8"))
    return tmp_path, runtime, source


def namespace(file: str = "report.md", sender: str = "grokbot", title: str = "\u898b\u56de\u308a / \u7d50\u679c"):
    return cli.build_parser().parse_args(["inbox-post", "--from", sender, "--title", title, "--file", file])


@pytest.mark.parametrize("suffix", [".md", ".txt", ".MD", ".TXT"])
def test_copy_preserves_content_and_uses_a_relative_safe_inbox_path(inbox, suffix):
    root, runtime, original = inbox
    source = root / ("source" + suffix)
    source.write_bytes(original.read_bytes())
    cmd, args = cli.request_for(namespace(source.name))
    assert cmd == "inbox.post"
    assert args["from"] == "grokbot"
    assert args["title"] == "\u898b\u56de\u308a / \u7d50\u679c"
    relative = Path(args["path"])
    assert not relative.is_absolute()
    assert relative.parts[0] == "grokbot"
    assert relative.suffix == ".md"
    assert (runtime / "inbox" / relative).read_bytes() == source.read_bytes()
    assert original.exists()
    assert len(list((runtime / "inbox/grokbot").iterdir())) == 1


def test_publish_happens_after_complete_copy_and_before_socket_request(inbox, monkeypatch):
    root, runtime, source = inbox
    rename = cli.os.rename
    seen = []

    def check_rename(temporary, destination):
        assert temporary.suffix == ".partial"
        assert temporary.read_bytes() == source.read_bytes()
        assert not destination.exists()
        assert not list(destination.parent.glob("*.md"))
        seen.append("rename")
        rename(temporary, destination)

    def request(cmd, args):
        assert seen == ["rename"]
        assert (runtime / "inbox" / args["path"]).read_bytes() == source.read_bytes()
        seen.append("post")
        return {"ok": True, **args}

    monkeypatch.setattr(cli.os, "rename", check_rename)
    monkeypatch.setattr(cli, "send_request", request)
    assert cli.main(["inbox-post", "--from", "grokbot", "--title", "Result", "--file", "report.md"]) == 0
    assert seen == ["rename", "post"]


@pytest.mark.parametrize("file", [
    "../outside.md", "/tmp/outside.md", "C:/outside.md", "C:outside.md",
    r"\\server\share\file.md", "//server/share/file.md", "report.html",
    "report.md:stream", "missing.md",
])
def test_rejects_unsafe_source_paths_without_publishing(inbox, file):
    _, runtime, _ = inbox
    with pytest.raises(RuntimeError):
        cli.copy_inbox_report(namespace(file))
    assert not runtime.exists()


@pytest.mark.parametrize("sender", ["..", "", "/tmp", "a/b", r"a\b", "CON", "nul", "COM1", "x:stream"])
def test_rejects_unsafe_sender(inbox, sender):
    _, runtime, _ = inbox
    with pytest.raises(RuntimeError):
        cli.copy_inbox_report(namespace(sender=sender))
    assert not runtime.exists()


@pytest.mark.parametrize("title", ["", "  ", "a\nb", "\x00", "\x7f", "\u0085", "a" * 257])
def test_rejects_invalid_title(inbox, title):
    _, runtime, _ = inbox
    with pytest.raises(RuntimeError):
        cli.copy_inbox_report(namespace(title=title))
    assert not runtime.exists()


def test_two_mb_boundary_and_over_limit(inbox):
    _, runtime, source = inbox
    source.write_bytes(b"x" * cli.INBOX_MAX_BYTES)
    args = cli.copy_inbox_report(namespace())
    assert (runtime / "inbox" / args["path"]).stat().st_size == cli.INBOX_MAX_BYTES
    source.write_bytes(b"x" * (cli.INBOX_MAX_BYTES + 1))
    with pytest.raises(RuntimeError, match="2MB"):
        cli.copy_inbox_report(namespace())
    assert len(list((runtime / "inbox/grokbot").glob("*.md"))) == 1


def test_long_japanese_title_stays_within_portable_filename_byte_limit(inbox):
    _, runtime, _ = inbox
    title = "\u7d50" * 256
    args = cli.copy_inbox_report(namespace(title=title))
    assert args["title"] == title
    assert len(Path(args["path"]).name.encode("utf-8")) <= 255
    assert (runtime / "inbox" / args["path"]).is_file()


def test_same_title_produces_two_distinct_files(inbox):
    first = cli.copy_inbox_report(namespace())
    second = cli.copy_inbox_report(namespace())
    assert first["path"] != second["path"]


def test_socket_failure_keeps_published_report_and_does_not_retry(inbox, monkeypatch, capsys):
    _, runtime, _ = inbox
    calls = []

    def fail(cmd, args):
        calls.append((cmd, args))
        raise RuntimeError("Frontend not ready")

    monkeypatch.setattr(cli, "send_request", fail)
    assert cli.main(["inbox-post", "--from", "dot", "--title", "Result", "--file", "report.md"]) == 1
    assert len(calls) == 1
    assert len(list((runtime / "inbox/dot").glob("*.md"))) == 1
    assert "Frontend not ready" in capsys.readouterr().err


def test_failed_publish_never_calls_socket_and_retains_partial(inbox, monkeypatch):
    _, runtime, _ = inbox

    def fail(*_):
        raise OSError("synthetic rename failure")

    monkeypatch.setattr(cli.os, "rename", fail)
    calls = []
    monkeypatch.setattr(cli, "send_request", lambda *args: calls.append(args))
    assert cli.main(["inbox-post", "--from", "dot", "--title", "Result", "--file", "report.md"]) == 1
    assert not calls
    assert not list((runtime / "inbox/dot").glob("*.md"))
    assert len(list((runtime / "inbox/dot").glob("*.partial"))) == 1


def test_rejects_linked_source_or_destination(inbox):
    root, runtime, source = inbox
    link = root / "link.md"
    try:
        link.symlink_to(source)
    except OSError:
        pytest.skip("symlink creation unavailable; Windows junctions have a separate test")
    with pytest.raises(RuntimeError, match="symlinks"):
        cli.copy_inbox_report(namespace("link.md"))
    outside = root / "outside"
    outside.mkdir()
    runtime.mkdir()
    (runtime / "inbox").symlink_to(outside, target_is_directory=True)
    with pytest.raises(RuntimeError, match="symlinks"):
        cli.copy_inbox_report(namespace())
    assert not list(outside.iterdir())


@pytest.mark.skipif(os.name != "nt", reason="Windows junction fixture")
def test_rejects_windows_inbox_junction(inbox):
    root, runtime, _ = inbox
    outside = root / "outside"
    outside.mkdir()
    runtime.mkdir()
    junction = runtime / "inbox"
    result = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    with pytest.raises(RuntimeError, match="junctions"):
        cli.copy_inbox_report(namespace())
    assert not list(outside.iterdir())


def test_real_cli_posts_to_only_the_fake_loopback_socket(inbox):
    root, runtime, source = inbox
    runtime.mkdir()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(5)
    (runtime / "mycmux.port").write_text(str(listener.getsockname()[1]), encoding="utf-8")
    (runtime / "mycmux.token").write_text("fixture-only-token", encoding="utf-8")
    requests, errors = [], []

    def serve():
        try:
            connection, _ = listener.accept()
            with connection, connection.makefile("rb") as reader:
                request = json.loads(reader.readline())
                requests.append(request)
                assert (runtime / "inbox" / request["args"]["path"]).read_bytes() == source.read_bytes()
                connection.sendall(b'{"id":1,"result":{"ok":true},"error":null}\n')
        except BaseException as error:
            errors.append(error)
        finally:
            listener.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    env = os.environ.copy()
    env["MYCMUX_RUNTIME_DIR"] = str(runtime)
    result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT), "inbox-post",
                             "--from", "codex", "--title", "Result", "--file", "report.md"],
                            cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", timeout=10)
    thread.join(6)
    assert not thread.is_alive()
    assert not errors
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"ok": True}
    assert len(requests) == 1
    assert requests[0]["cmd"] == "inbox.post"
    assert requests[0]["token"] == "fixture-only-token"


def test_new_inbox_commands_are_async_and_registered():
    rust = (ROOT / "src-tauri/src/commands/inbox.rs").read_text(encoding="utf-8")
    lib = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    for name in ("inbox_post", "inbox_recent", "inbox_preview"):
        assert f"pub async fn {name}(" in rust
        assert f"commands::inbox::{name}," in lib
    assert '"inbox.post"' in (ROOT / "src-tauri/src/socket.rs").read_text(encoding="utf-8")
    # Validated file names must not be decoded/repaired as scraped terminal URIs.
    assert "super::artifact::preview_info_for_artifact(&session_id, &path, true)" in rust
    assert "artifact_path_from_uri" not in rust
    assert "preview_artifact_uri_for_session_v2" not in rust
