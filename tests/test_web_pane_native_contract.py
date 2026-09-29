import re
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "src-tauri/src/commands/webpane_native.rs"
WINDOWS = ROOT / "src-tauri/src/commands/webpane_native_win.rs"
COMMANDS = ("webpane_screenshot", "webpane_input_trusted", "webpane_set_file_input")


def command_source(command: str) -> tuple[str, str]:
    source = NATIVE.read_text(encoding="utf-8")
    match = re.search(
        rf"pub async fn {command}\((.*?)\) -> Result<[^\n]+> \{{(.*?)(?=\n#\[)",
        source,
        re.S,
    )
    assert match, command
    return match.group(1), match.group(2)


@pytest.mark.parametrize("command", COMMANDS)
def test_native_command_rejects_child_webviews_before_platform_or_native_work(command: str) -> None:
    signature, body = command_source(command)
    assert "caller: tauri::Webview" in signature
    guard = "if caller.label() != caller.window().label() {"
    assert body.lstrip().startswith(guard)
    assert re.search(
        rf'if caller\.label\(\) != caller\.window\(\)\.label\(\) \{{\s*return Err\(\s*"{command} is only available to the primary app webview"\.to_string\(\),?\s*\);\s*\}}',
        body,
    )
    assert body.index(guard) < body.index("#[cfg(windows)]") < body.index("super::webpane_native_win::")


def test_native_sources_do_not_open_debugging_ports_or_use_cookie_apis() -> None:
    source = NATIVE.read_text(encoding="utf-8") + WINDOWS.read_text(encoding="utf-8")
    for forbidden in (
        "remote-debugging", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "set_cookie", "cookies_for_url", "cookie_manager", "ICoreWebView2CookieManager",
        "Network.getCookies", "Network.getAllCookies", "Storage.getCookies",
        "Network.setCookie", "Network.deleteCookies", "Network.clearBrowserCookies",
    ):
        assert forbidden not in source, forbidden


@pytest.mark.parametrize("command", COMMANDS)
def test_every_native_command_awaits_the_shared_deadline(command: str) -> None:
    _, body = command_source(command)
    assert "NativeBudget::new(" in body
    assert re.search(r"budget\s*\.run\(super::webpane_native_win::", body)
    assert "&budget" in body and ".await" in body


@pytest.mark.parametrize("command", COMMANDS)
def test_native_commands_forward_the_optional_socket_budget_and_command_name(command: str) -> None:
    signature, body = command_source(command)
    assert "budget_ms: Option<u64>" in signature
    assert "command: Option<String>" in signature
    default = {
        "webpane_screenshot": '"web.screenshot"',
        "webpane_input_trusted": "action.command_name()",
        "webpane_set_file_input": '"web.upload"',
    }[command]
    assert re.search(
        rf"NativeBudget::new\(\s*{re.escape(default)}\s*,\s*budget_ms\s*,\s*command\s*\)",
        body,
    )


def test_generation_guard_precedes_native_input_and_upload_work() -> None:
    source = WINDOWS.read_text(encoding="utf-8")
    trusted = source.split("pub(super) async fn input_trusted(", 1)[1].split("fn input_files(", 1)[0]
    upload = source.split("pub(super) async fn set_file_input(", 1)[1].split("#[cfg(test)]", 1)[0]
    for body, next_work in [(trusted, "let (kind, events)"), (upload, "tokio::task::spawn_blocking")]:
        assert body.index("check_generation(") < body.index(next_work)
        assert '"Runtime.evaluate"' in body[:body.index(next_work)]
    signature, _ = command_source("webpane_set_file_input")
    assert "expected_generation: Option<u64>" in signature
