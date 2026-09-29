"""Offline fixture checks; the E2E script itself is run only by the parent operator."""

import ast
import importlib.util
import json
import pytest
from html.parser import HTMLParser
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "web-automation" / "index.html"
VERIFIER = ROOT / "scripts" / "verify_web_automation.py"


class FixtureParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.external: list[str] = []
        self.tags: list[tuple[str, dict[str, str | None]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        self.tags.append((tag, values))
        if values.get("id"):
            self.ids.add(values["id"])
        for attribute in ("src", "href", "action", "srcset"):
            value = values.get(attribute)
            if value and not value.startswith(("#", "data:")):
                self.external.append(value)


def test_fixture_is_self_contained_and_covers_the_e2e_targets() -> None:
    source = FIXTURE.read_text(encoding="utf-8")
    parser = FixtureParser()
    parser.feed(source)
    assert not parser.external
    assert not re.search(r"@import|url\s*\(", source, re.I)
    required = {"heading", "link", "counter", "count", "text-input", "editable", "file-input",
                "dropzone", "select", "scroller", "scroll-content", "alert-button", "download-link"}
    assert required <= parser.ids
    verifier = VERIFIER.read_text(encoding="utf-8")
    assert set(re.findall(r'"#([\w-]+)"', verifier)) <= parser.ids
    for feature in ("window.__state", "isTrusted", "beforeinput", '"input"', "contenteditable",
                    "dragenter", "dragover", "drop", "download=", "alert("):
        assert feature in source
    ast.parse(verifier)
    assert '"--background"' in verifier
    assert 'cli("web-focus"' not in verifier
    assert '("127.0.0.1", 0)' in verifier
    assert 'env["MYCMUX_RUNTIME_DIR"]' in verifier


def load_verifier():
    spec = importlib.util.spec_from_file_location("web_automation_verifier", VERIFIER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(("windows", "skip", "error", "expected"), [
    (True, False, "not supported", "FAIL"),
    (False, False, "not supported", "SKIP"),
    (True, True, None, "FAIL"),
    (False, True, None, "SKIP"),
    (True, False, None, "PASS"),
    (False, False, "broken PNG", "FAIL"),
])
def test_screenshot_policy_never_skips_windows(windows, skip, error, expected) -> None:
    verifier = load_verifier()
    calls = []
    def action():
        calls.append(True)
        if error:
            raise RuntimeError(error)
    status, _ = verifier.screenshot_result(action, windows=windows, skip=skip)
    assert status == expected
    assert len(calls) == (0 if skip else 1)


def trusted_fake(fixture: Path, bad: str | None = None):
    data = {"counter": 1, "clicks": [{"isTrusted": False}], "files": [],
            "keys": [{"key": "Enter", "isTrusted": False}], "text": "old"}
    calls = []
    files = [{"name": fixture.name, "size": fixture.stat().st_size}]
    def state():
        return json.loads(json.dumps(data))
    def cli(*argv):
        calls.append(argv)
        command = argv[0]
        if command == "web-eval":
            data["files"] = []
            return {"value": None}
        if command == "web-find":
            return {"nodes": [{"ref": "r9"}]}
        assert "--trusted" in argv
        if command == "web-click":
            data["counter"] += 1
            data["clicks"].append({"isTrusted": bad != command})
        elif command == "web-upload":
            data["files"] = [] if bad == command else files
            return {"files": data["files"]}
        elif command == "web-key":
            data["keys"].append({"key": "Enter", "isTrusted": bad != command})
        elif command == "web-type":
            data["text"] = "wrong" if bad == command else argv[argv.index("--text") + 1]
        else:
            raise AssertionError(command)
        return {}
    return cli, state, calls


def test_trusted_e2e_checks_run_all_four_commands_on_windows(tmp_path: Path) -> None:
    verifier = load_verifier()
    fixture = tmp_path / "fixture.txt"
    fixture.write_text("hello", encoding="utf-8")
    cli, state, calls = trusted_fake(fixture)
    steps = []
    def step(name, action):
        steps.append(name)
        action()
    verifier.run_trusted_checks(cli, state, fixture, step, windows=True)
    assert steps == ["trusted click", "trusted upload", "trusted key", "trusted type"]
    assert [call[0] for call in calls if "--trusted" in call] == ["web-click", "web-upload", "web-key", "web-type"]
    assert state()["clicks"][-1]["isTrusted"] is True
    assert state()["keys"][-1]["isTrusted"] is True


@pytest.mark.parametrize(("bad", "name"), [
    ("web-click", "trusted click"), ("web-upload", "trusted upload"),
    ("web-key", "trusted key"), ("web-type", "trusted type"),
])
def test_trusted_e2e_checks_reject_missing_native_effects(tmp_path: Path, bad: str, name: str) -> None:
    verifier = load_verifier()
    fixture = tmp_path / "fixture.txt"
    fixture.write_text("hello", encoding="utf-8")
    cli, state, _ = trusted_fake(fixture, bad)
    with pytest.raises(RuntimeError):
        dict(verifier.trusted_checks(cli, state, fixture))[name]()


def test_trusted_e2e_checks_skip_only_non_windows(capsys) -> None:
    verifier = load_verifier()
    def forbidden(*args):
        raise AssertionError("non-Windows must not send trusted commands")
    verifier.run_trusted_checks(forbidden, forbidden, FIXTURE, forbidden, windows=False)
    assert capsys.readouterr().out.count("SKIP trusted ") == 4


def test_docs_ref_lifetime_includes_hash_navigation() -> None:
    text = (ROOT / "docs" / "agent-integration.md").read_text(encoding="utf-8")
    assert "ref は同一文書内で有効（hash 遷移では維持・ページ遷移と reload で無効）" in text


def test_docs_focus_is_explicit_and_targeted_by_tab() -> None:
    text = (ROOT / "docs" / "agent-integration.md").read_text(encoding="utf-8")
    assert "| `web-focus --tab <id>` | 明示時のみ前面化" in text
    assert "close / focus は `--tab` のみ（`--preset` 不可）" in text
