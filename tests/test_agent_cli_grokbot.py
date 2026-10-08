"""Grok Bot CLI contracts. All requests, keys and homes are isolated test fixtures."""
from __future__ import annotations

import argparse
from datetime import datetime
import http.client
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import traceback
from types import SimpleNamespace
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import mycmux_agent_cli as cli  # noqa: E402

KEY = "TEST_ONLY_GROKBOT_KEY_MARKER"
PATH_SECRET = "TEST_ONLY_URL_PATH_MARKER"
QUERY_SECRET = "TEST_ONLY_URL_QUERY_MARKER"
URL = f"https://routines.example.test/hook/{PATH_SECRET}?secret={QUERY_SECRET}"
WINDOWS_PRIVATE = cli.grokbot_windows_private
CLIPBOARD_KEY = cli.grokbot_clipboard_key


def arguments(*args: str) -> argparse.Namespace:
    return cli.build_parser().parse_args(["grokbot", *args])


def forbidden(*_args: Any, **_kwargs: Any) -> Any:
    raise AssertionError("live API, clipboard or socket access is forbidden in these tests")


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    runtime = tmp_path / "isolated-runtime"
    monkeypatch.setenv("MYCMUX_RUNTIME_DIR", str(runtime))
    monkeypatch.setattr(cli, "send_request", forbidden)
    monkeypatch.setattr(http.client, "HTTPSConnection", forbidden)
    monkeypatch.setattr(cli, "grokbot_clipboard_key", forbidden)
    # Most tests exercise behavior with fake secrets. A-3 below runs the actual ACL command.
    monkeypatch.setattr(cli, "grokbot_windows_private", lambda _path: None)
    return runtime


def register(tmp_path: Path, name: str = "watch", url: str = URL) -> dict[str, Any]:
    source = tmp_path / "input-key.txt"
    source.write_text(KEY + "\n", encoding="utf-8")
    return cli.grokbot_add(arguments("routine-add", "--name", name, "--url", url,
                                     "--key-file", str(source)))


@pytest.fixture
def registered(tmp_path: Path) -> Path:
    register(tmp_path)
    return cli.grokbot_directory()


class FakeHTTPS:
    def __init__(self, status: int = 200, error: Exception | None = None) -> None:
        self.status = status
        self.error = error
        self.calls: list[tuple[Any, ...]] = []
        self.sock = SimpleNamespace(settimeout=lambda timeout: self.calls.append(("deadline", timeout)))
        self.closed = False

    def set_debuglevel(self, level: int) -> None:
        self.calls.append(("debug", level))

    def request(self, method: str, target: str, *, body: bytes, headers: dict[str, str]) -> None:
        self.calls.append(("request", method, target, body, headers))
        if self.error is not None:
            raise self.error

    def getresponse(self) -> Any:
        self.calls.append(("response",))
        # The CLI must not read reason, headers or body (which may echo a secret).
        return SimpleNamespace(status=self.status)

    def close(self) -> None:
        self.closed = True


def fake_https(monkeypatch: pytest.MonkeyPatch, connection: FakeHTTPS) -> list[tuple[Any, ...]]:
    created = []

    def create(host: str, port: int | None, *, timeout: float) -> FakeHTTPS:
        created.append((host, port, timeout))
        return connection

    monkeypatch.setattr(http.client, "HTTPSConnection", create)
    return created


def assert_no_secrets(value: str) -> None:
    for secret in (KEY, PATH_SECRET, QUERY_SECRET):
        assert secret not in value


def test_add_list_remove_preserve_private_registration_and_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    source = tmp_path / "key.txt"
    source.write_text(KEY + "\n", encoding="utf-8")
    assert cli.main(["grokbot", "routine-add", "--name", "watch", "--url", URL,
                     "--key-file", str(source)]) == 0
    directory = cli.grokbot_directory()
    metadata = (directory / "watch.json").read_bytes()
    assert KEY not in metadata.decode("utf-8")
    assert json.loads(metadata)["url"] == URL
    assert (directory / "watch.key").read_text(encoding="utf-8") == KEY
    assert cli.main(["grokbot", "list"]) == 0
    output = capsys.readouterr()
    assert json.loads(output.out.splitlines()[1]) == [
        {"name": "watch", "host": "routines.example.test", "has_key": True},
    ]
    assert_no_secrets(output.out + output.err + caplog.text)
    assert cli.main(["grokbot", "routine-remove", "--name", "watch"]) == 0
    assert not (directory / "watch.key").exists() and not (directory / "watch.json").exists()
    archived_key = list((directory / "_old").glob("*/watch.key"))
    assert len(archived_key) == 1 and archived_key[0].read_text(encoding="utf-8") == KEY
    assert archived_key[0].with_suffix(".json").read_bytes() == metadata
    assert cli.grokbot_list() == []
    output = capsys.readouterr()
    assert_no_secrets(output.out + output.err + caplog.text)


def test_duplicate_is_rejected_without_overwriting_key_or_registration(
    registered: Path, tmp_path: Path,
) -> None:
    before = {path.name: path.read_bytes() for path in registered.iterdir()}
    with pytest.raises(cli.GrokbotError, match="already exists"):
        register(tmp_path)
    assert before == {path.name: path.read_bytes() for path in registered.iterdir()}


def test_repeated_remove_uses_distinct_archives(tmp_path: Path) -> None:
    for _ in range(2):
        register(tmp_path)
        cli.grokbot_remove("watch")
    archived = list((cli.grokbot_directory() / "_old").glob("*/watch.key"))
    assert len(archived) == 2 and all(path.read_text(encoding="utf-8") == KEY for path in archived)


def test_missing_key_is_reported_as_bool_and_remove_handles_orphan(
    registered: Path,
) -> None:
    key = registered / "watch.key"
    key.rename(registered / "detached.key")
    assert cli.grokbot_list() == [
        {"name": "watch", "host": "routines.example.test", "has_key": False},
    ]
    with pytest.raises(cli.GrokbotError, match="cannot read"):
        cli.grokbot_run(arguments("run", "--name", "watch"))
    cli.grokbot_remove("watch")
    assert list((registered / "_old").glob("*/watch.json"))


def test_partial_registration_is_retained_and_can_be_archived(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "key.txt"
    source.write_text(KEY, encoding="utf-8")
    write = cli.grokbot_write_private

    def fail_metadata(path: Path, value: str) -> None:
        if path.suffix == ".json":
            raise OSError(KEY + PATH_SECRET + QUERY_SECRET)
        write(path, value)

    monkeypatch.setattr(cli, "grokbot_write_private", fail_metadata)
    assert cli.main(["grokbot", "routine-add", "--name", "watch", "--url", URL,
                     "--key-file", str(source)]) == 1
    directory = cli.grokbot_directory()
    assert (directory / "watch.key").read_text(encoding="utf-8") == KEY
    assert_no_secrets(capsys.readouterr().err)
    cli.grokbot_remove("watch")
    assert len(list((directory / "_old").glob("*/watch.key"))) == 1


@pytest.mark.parametrize("name", [
    "", ".", "..", "../escape", "a/b", "a\\b", "CON", "nul.txt", "COM1", "LPT9",
    "_OLD", "trailing.", "name ", "a:b", "a\nname", "x" * 201,
])
def test_names_reject_traversal_and_nonportable_filenames(name: str) -> None:
    with pytest.raises(cli.GrokbotError):
        cli.grokbot_name(name)


def test_japanese_names_are_preserved(tmp_path: Path) -> None:
    name = "\u5165\u8a66\u5236\u5ea6-\u898b\u5f35\u308a"
    register(tmp_path, name=name)
    assert cli.grokbot_list()[0]["name"] == name
    assert cli.grokbot_remove(name)["routine"] == name


@pytest.mark.parametrize("url", [
    f"http://routines.example.test/{PATH_SECRET}",
    f"https://user:{KEY}@routines.example.test/{PATH_SECRET}",
    f"https://routines.example.test/{PATH_SECRET}#{QUERY_SECRET}",
    f"https://routines.example.test:{QUERY_SECRET}/",
    f"https://routines.example.test:0/{PATH_SECRET}",
    f"https://routines.example.test:65536/{PATH_SECRET}",
    f"https:///{PATH_SECRET}",
    f"https://routines.example.test/\n{PATH_SECRET}",
    f"https://routines.example.test/\\{PATH_SECRET}",
])
def test_invalid_urls_are_rejected_before_any_key_read(
    tmp_path: Path, url: str, capsys: pytest.CaptureFixture[str],
) -> None:
    assert cli.main(["grokbot", "routine-add", "--name", "watch", "--url", url]) == 1
    output = capsys.readouterr()
    assert_no_secrets(output.out + output.err)
    assert not cli.grokbot_directory().exists()


def test_allowed_hosts_default_empty_and_exact_match_with_run_recheck(
    tmp_path: Path, registered: Path,
) -> None:
    assert cli.grokbot_allowed_hosts() == []
    config = registered.parent / "config.json"
    config.write_text(json.dumps({"allowed_hosts": ["ROUTINES.EXAMPLE.TEST"]}), encoding="utf-8")
    cli.grokbot_url(URL)
    for blocked in (URL.replace("routines.example.test", "sub.routines.example.test"),
                    URL.replace("routines.example.test", "routines.example.test.evil")):
        with pytest.raises(cli.GrokbotError, match="not allowed"):
            cli.grokbot_url(blocked)
    config.write_text('{"allowed_hosts": ["another.example.test"]}', encoding="utf-8")
    with pytest.raises(cli.GrokbotError, match="not allowed"):
        cli.grokbot_run(arguments("run", "--name", "watch"))
    # Tightening the policy does not hide already registered names from list.
    assert cli.grokbot_list()[0]["host"] == "routines.example.test"
    config.write_text('{"allowed_hosts": []}', encoding="utf-8")
    cli.grokbot_url(URL)


@pytest.mark.parametrize("config", ["[]", "invalid", '{"allowed_hosts": "all"}',
                                  '{"allowed_hosts": ["https://example.test"]}',
                                  '{"allowed_hosts": ["*.example.test"]}',
                                  '{"allowed_hosts": [null]}'])
def test_malformed_host_policy_fails_closed(registered: Path, config: str) -> None:
    (registered.parent / "config.json").write_text(config, encoding="utf-8")
    with pytest.raises(cli.GrokbotError, match="configuration"):
        cli.grokbot_run(arguments("run", "--name", "watch"))


@pytest.mark.parametrize("status", [200, 202, 301, 302, 307, 308, 400, 401, 429, 500])
def test_run_posts_once_and_reports_acceptance_only(
    registered: Path, monkeypatch: pytest.MonkeyPatch, status: int,
    capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture,
) -> None:
    connection = FakeHTTPS(status)
    created = fake_https(monkeypatch, connection)
    text = "\u5165\u8a66\u5236\u5ea6\u3092\u78ba\u8a8d\nquote \"hello\""
    assert cli.main(["grokbot", "run", "--name", "watch", "--text", text]) == int(status != 200)
    output = capsys.readouterr()
    result = json.loads(output.out)
    assert set(result) == {"ok", "status", "routine", "sent_at"}
    assert result["ok"] is (status == 200) and result["status"] == status
    assert result["routine"] == "watch"
    assert datetime.fromisoformat(result["sent_at"]).utcoffset().total_seconds() == 0
    assert created == [("routines.example.test", 443, 30.0)]
    requests = [call for call in connection.calls if call[0] == "request"]
    assert len(requests) == 1
    _, method, target, body, headers = requests[0]
    assert method == "POST" and target == f"/hook/{PATH_SECRET}?secret={QUERY_SECRET}"
    assert headers == {"Authorization": "Bearer " + KEY,
                       "Content-Type": "application/json; charset=utf-8"}
    assert json.loads(body) == {"text": text, "from": "mycmux", "sent_at": result["sent_at"]}
    deadline = next(call[1] for call in connection.calls if call[0] == "deadline")
    assert 0 < deadline <= 30.0
    assert ("debug", 0) in connection.calls and connection.closed
    assert_no_secrets(output.out + output.err + caplog.text)


def test_json_body_retains_fields_and_overrides_origin_and_timestamp(
    tmp_path: Path, registered: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "body.json"
    payload = {"topic": "\u7af6\u5408\u65b0\u520a", "nested": {"count": 2},
               "from": "untrusted", "sent_at": "old"}
    source.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    original = source.read_bytes()
    connection = FakeHTTPS()
    fake_https(monkeypatch, connection)
    result = cli.grokbot_run(arguments("run", "--name", "watch", "--json-file", str(source)))
    request = next(call for call in connection.calls if call[0] == "request")
    assert json.loads(request[3]) == {**payload, "from": "mycmux", "sent_at": result["sent_at"]}
    assert source.read_bytes() == original


def test_no_body_option_uses_empty_text(
    registered: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = FakeHTTPS()
    fake_https(monkeypatch, connection)
    cli.grokbot_run(arguments("run", "--name", "watch"))
    request = next(call for call in connection.calls if call[0] == "request")
    assert json.loads(request[3])["text"] == ""


@pytest.mark.parametrize("data", ["[]", "1", "null", "invalid", '{"value": NaN}'])
def test_invalid_json_body_never_sends(registered: Path, tmp_path: Path, data: str) -> None:
    source = tmp_path / "bad.json"
    source.write_text(data, encoding="utf-8")
    with pytest.raises(cli.GrokbotError):
        cli.grokbot_run(arguments("run", "--name", "watch", "--json-file", str(source)))


@pytest.mark.parametrize("error_type", [TimeoutError, socket.timeout, OSError,
                                       ValueError, http.client.BadStatusLine])
def test_network_exceptions_are_redacted_and_never_retried(
    registered: Path, monkeypatch: pytest.MonkeyPatch, error_type: type[Exception],
    capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture,
) -> None:
    connection = FakeHTTPS(error=error_type(KEY + PATH_SECRET + QUERY_SECRET))
    created = fake_https(monkeypatch, connection)
    assert cli.main(["grokbot", "run", "--name", "watch"]) == 1
    output = capsys.readouterr()
    result = json.loads(output.out)
    assert result["ok"] is False and result["status"] is None
    assert "acceptance is unknown; no retry was made" in output.err
    assert len(created) == 1 and connection.closed
    assert len([call for call in connection.calls if call[0] == "request"]) == 1
    assert_no_secrets(output.out + output.err + caplog.text)


def test_post_exception_has_no_secret_context(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_https(monkeypatch, FakeHTTPS(error=OSError(KEY + PATH_SECRET + QUERY_SECRET)))
    with pytest.raises(cli.GrokbotError) as error:
        cli.grokbot_post(cli.grokbot_url(URL), KEY, b"{}")
    rendered = "".join(traceback.format_exception(type(error.value), error.value, error.value.__traceback__))
    assert error.value.__context__ is None
    assert_no_secrets(str(error.value) + rendered)


def test_request_deadline_is_not_reset_after_send(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = FakeHTTPS()
    fake_https(monkeypatch, connection)
    ticks = iter([10.0, 41.0])
    monkeypatch.setattr(cli.time, "monotonic", lambda: next(ticks))
    with pytest.raises(cli.GrokbotError, match="timed out"):
        cli.grokbot_post(cli.grokbot_url(URL), KEY, b"{}")
    assert ("response",) not in connection.calls and connection.closed


@pytest.mark.parametrize("args", [
    ["routine-add", "--name", "watch", "--url", URL, "--key", KEY],
    ["routine-add", "--name", "watch", "--url", URL, "--unknown", QUERY_SECRET],
    [PATH_SECRET],
    ["run", "--name", "watch", "--text", KEY, "--json-file", QUERY_SECRET],
])
def test_parser_errors_never_echo_supplied_secret_arguments(
    args: list[str], capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture,
) -> None:
    assert cli.main(["grokbot", *args]) == 2
    output = capsys.readouterr()
    assert "invalid grokbot arguments" in output.err
    assert_no_secrets(output.out + output.err + caplog.text)


def test_help_documents_acceptance_and_key_file_without_socket(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert cli.main(["grokbot", "routine-add", "--help"]) == 0
    assert "--key-file" in capsys.readouterr().out
    assert cli.main(["grokbot", "run", "--help"]) == 0
    assert "HTTP 200 means accepted, not completed" in capsys.readouterr().out


@pytest.mark.parametrize("key", ["", "  ", "x\ny", "x y", "\u65e5\u672c\u8a9e", "x" * 8193])
def test_invalid_key_is_rejected_without_echo(key: str) -> None:
    with pytest.raises(cli.GrokbotError) as error:
        cli.grokbot_key(key)
    assert KEY not in str(error.value)


def test_missing_key_file_error_does_not_echo_filename(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / (KEY + PATH_SECRET + QUERY_SECRET)
    assert cli.main(["grokbot", "routine-add", "--name", "watch", "--url", URL,
                     "--key-file", str(source)]) == 1
    output = capsys.readouterr()
    assert_no_secrets(output.out + output.err)


@pytest.mark.parametrize("platform,command", [
    ("win32", "powershell.exe"), ("darwin", "pbpaste"), ("linux", "wl-paste"),
])
def test_clipboard_is_read_after_enter_and_not_echoed(
    monkeypatch: pytest.MonkeyPatch, platform: str, command: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    events = []
    monkeypatch.setattr(cli.sys, "platform", platform)
    monkeypatch.setattr("builtins.input", lambda prompt: events.append(("enter", prompt)))

    def read(args: list[str], **kwargs: Any) -> Any:
        events.append(("clipboard", args, kwargs))
        return SimpleNamespace(stdout=KEY + "\n")

    monkeypatch.setattr(subprocess, "run", read)
    assert CLIPBOARD_KEY() == KEY
    assert events[0][0] == "enter" and events[1][0] == "clipboard"
    assert events[1][1][0] == command and events[1][2]["capture_output"] is True
    assert KEY not in repr(events)
    output = capsys.readouterr()
    assert_no_secrets(output.out + output.err)


def test_add_uses_clipboard_only_when_key_file_is_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []
    monkeypatch.setattr(cli, "grokbot_clipboard_key", lambda: calls.append(1) or KEY)
    cli.grokbot_add(arguments("routine-add", "--name", "clip", "--url", URL))
    assert calls == [1]
    register(tmp_path, name="file")
    assert calls == [1]


def test_storage_and_archive_links_are_rejected(
    registered: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    real = cli.grokbot_is_link
    for blocked in (registered, registered / "watch.json", registered / "watch.key",
                    registered / "_old"):
        monkeypatch.setattr(cli, "grokbot_is_link", lambda path, target=blocked: path == target or real(path))
        with pytest.raises(cli.GrokbotError, match="links|junctions"):
            if blocked.name == "_old":
                cli.grokbot_remove("watch")
            else:
                cli.grokbot_run(arguments("run", "--name", "watch"))


def test_private_write_cannot_overwrite_existing_file(tmp_path: Path) -> None:
    path = tmp_path / "existing.key"
    path.write_text("original", encoding="utf-8")
    with pytest.raises(FileExistsError):
        cli.grokbot_write_private(path, KEY)
    assert path.read_text(encoding="utf-8") == "original"


def test_private_key_actual_permissions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cli, "grokbot_windows_private", WINDOWS_PRIVATE)
    register(tmp_path)
    key = cli.grokbot_directory() / "watch.key"
    metadata = key.with_suffix(".json")
    if sys.platform == "win32":
        for path in (key, metadata):
            result = subprocess.run(["icacls", str(path)], capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=10, check=True)
            grants = [line for line in result.stdout.splitlines() if ":(F)" in line]
            assert len(grants) == 1 and "(I)" not in result.stdout
            assert not any(principal in result.stdout for principal in
                           ("BUILTIN\\", "NT AUTHORITY\\", "Everyone"))
        print("A-3 key ACL (isolated fake key):\n" + subprocess.run(
            ["icacls", str(key)], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10, check=True,
        ).stdout)
        cli.grokbot_remove("watch")
        archived = next((key.parent / "_old").glob("*/watch.key"))
        result = subprocess.run(["icacls", str(archived)], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=10, check=True)
        assert len([line for line in result.stdout.splitlines() if ":(F)" in line]) == 1
        assert "(I)" not in result.stdout
    else:
        for path in (key, metadata):
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
        print("A-3 key and metadata POSIX mode: 600")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX mode enforced on POSIX")
def test_run_refuses_world_readable_key(registered: Path) -> None:
    (registered / "watch.key").chmod(0o644)
    with pytest.raises(cli.GrokbotError, match="permissions"):
        cli.grokbot_run(arguments("run", "--name", "watch"))


def test_acl_failure_is_redacted_and_no_key_bytes_are_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    def fail(_path: Path) -> None:
        raise cli.GrokbotError("cannot restrict grokbot file permissions")

    monkeypatch.setattr(cli, "grokbot_windows_private", fail)
    monkeypatch.setattr(cli.sys, "platform", "win32")
    source = tmp_path / "input.txt"
    source.write_text(KEY, encoding="utf-8")
    assert cli.main(["grokbot", "routine-add", "--name", "watch", "--url", URL,
                     "--key-file", str(source)]) == 1
    assert (cli.grokbot_directory() / "watch.key").read_bytes() == b""
    output = capsys.readouterr()
    assert_no_secrets(output.out + output.err)


def test_windows_acl_commands_capture_output_and_use_current_user_sid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []

    def invoke(args: list[str], **kwargs: Any) -> Any:
        calls.append((args, kwargs))
        return SimpleNamespace(stdout='"machine\\user","S-1-5-21-1-2-3-1001"\n')

    monkeypatch.setattr(subprocess, "run", invoke)
    path = tmp_path / "new.key"
    path.touch()
    WINDOWS_PRIVATE(path)
    assert calls[0][0] == ["whoami", "/user", "/fo", "csv", "/nh"]
    assert calls[1][0] == ["icacls", str(path), "/inheritance:r", "/grant:r",
                            "*S-1-5-21-1-2-3-1001:(F)"]
    assert all(kwargs["capture_output"] and kwargs["check"] for _, kwargs in calls)


def test_windows_acl_tool_exception_is_redacted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail(*args: Any, **kwargs: Any) -> Any:
        raise subprocess.CalledProcessError(1, args, output=KEY + PATH_SECRET + QUERY_SECRET)

    monkeypatch.setattr(subprocess, "run", fail)
    with pytest.raises(cli.GrokbotError) as error:
        WINDOWS_PRIVATE(tmp_path / KEY)
    assert_no_secrets(str(error.value) + "".join(
        traceback.format_exception(type(error.value), error.value, error.value.__traceback__),
    ))

@pytest.mark.parametrize("url,host,port,target", [
    ("https://[::1]/hook", "::1", 443, "/hook"),
    ("https://[::1]:8443/hook", "::1", 8443, "/hook"),
    ("https://routines.example.test", "routines.example.test", 443, "/"),
    ("https://routines.example.test:8443/hook", "routines.example.test", 8443, "/hook"),
])
def test_https_hosts_and_ports_are_preserved(
    monkeypatch: pytest.MonkeyPatch, url: str, host: str, port: int, target: str,
) -> None:
    connection = FakeHTTPS()
    created = fake_https(monkeypatch, connection)
    assert cli.grokbot_post(cli.grokbot_url(url), KEY, b"{}") == 200
    assert created == [(host, port, 30.0)]
    assert next(call for call in connection.calls if call[0] == "request")[2] == target


def test_response_timeout_is_redacted_and_not_retried(
    registered: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    class ResponseTimeout(FakeHTTPS):
        def getresponse(self) -> Any:
            self.calls.append(("response",))
            raise TimeoutError(KEY + PATH_SECRET + QUERY_SECRET)

    connection = ResponseTimeout()
    created = fake_https(monkeypatch, connection)
    assert cli.main(["grokbot", "run", "--name", "watch"]) == 1
    output = capsys.readouterr()
    assert json.loads(output.out)["status"] is None
    assert "acceptance is unknown; no retry was made" in output.err
    assert len(created) == 1 and connection.closed
    assert len([call for call in connection.calls if call[0] == "request"]) == 1
    assert_no_secrets(output.out + output.err + caplog.text)

@pytest.mark.parametrize("prefix", [["--verbose"], [KEY], ["--key", KEY]])
def test_malformed_grokbot_prefixes_do_not_echo_keys(
    prefix: list[str], capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture,
) -> None:
    assert cli.main([*prefix, "grokbot", "routine-add", "--name", "watch",
                     "--url", URL, "--key", KEY]) == 2
    output = capsys.readouterr()
    assert_no_secrets(output.out + output.err + caplog.text)


def test_existing_socket_command_with_grokbot_as_text_keeps_its_route(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    calls = []

    def send(command: str, args: dict[str, Any]) -> Any:
        calls.append((command, args))
        return {"submitted": False}

    monkeypatch.setattr(cli, "send_request", send)
    assert cli.main(["web-push", "--text", "grokbot", "--tab", "web-tab"]) == 0
    assert calls == [("web.push", {"submit": False, "text": "grokbot", "tabId": "web-tab"})]
    assert json.loads(capsys.readouterr().out) == {"submitted": False}
