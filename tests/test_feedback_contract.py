from __future__ import annotations

import re

import pytest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FEEDBACK = ROOT / "src-tauri" / "src" / "feedback"
FEEDBACK_LOG_PATTERN = re.compile(
    r"(?:log::\w+!|println!|eprintln!|dbg!)\s*\(|diag::\w+\s*\(|\b(?:trace|debug|info|warn|error)!\s*\(|tracing::"
)
COMMANDS = ("feedback_status", "feedback_save_destination", "feedback_remove_destination", "feedback_capture_main", "feedback_send")


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_feedback_commands_are_async_registered_and_guarded():
    text = read("src-tauri/src/feedback/commands.rs")
    registration = read("src-tauri/src/lib.rs")
    for command in COMMANDS:
        match = re.search(r"#\[tauri::command\]\s*pub async fn " + command + r"\((.*?)\)\s*->", text, re.S)
        assert match, command
        assert "TrustedAppCaller" in match[1], command
        assert "feedback::commands::" + command in registration


def test_feedback_transport_does_not_log_secrets_responses_or_images():
    paths = [p for p in FEEDBACK.glob("*.rs") if p.name != "tests.rs"]
    assert paths
    for path in paths:
        text = path.read_text(encoding="utf-8")
        assert not FEEDBACK_LOG_PATTERN.search(text), path
    text = read("src-tauri/src/feedback/transport.rs")
    assert ".https_only(true)" in text
    assert "Policy::none()" in text
    assert "Duration::from_secs(20)" in text
    assert "files.upload" not in text



@pytest.mark.parametrize("call", [
    "diag::warn(value)", "diag::error(value)", "trace!(value)", "debug!(value)",
    "info!(value)", "warn!(value)", "error!(value)", "tracing::event!(value)",
    "log::warn!(value)", "println!(value)", "eprintln!(value)", "dbg!(value)",
])
def test_feedback_log_contract_recognizes_all_diagnostic_sinks(call):
    assert FEEDBACK_LOG_PATTERN.search(call)


def test_feedback_status_checks_presence_without_requesting_secret_content():
    text = read("src-tauri/src/feedback/mod.rs")
    status = text.split("fn destination_status(", 1)[1].split("fn save_destination(", 1)[0]
    assert "store.exists()?" in status and "store.read()" not in status
    store = read("src-tauri/src/feedback/destination_store.rs")
    windows = store.split("fn exists(base:", 1)[1].split("fn read(", 1)[0]
    assert "try_exists()" in windows and "protect(" not in windows
    macos = store.split('const ACCOUNT: &[u8] = b"destination";', 1)[1].split("fn read(", 1)[0]
    assert "SecKeychainFindGenericPassword" in macos
    assert "ptr::null_mut(), ptr::null_mut(), &mut item" in macos
    assert "&mut data" not in macos and "&mut length" not in macos


def test_feedback_public_return_types_contain_only_status_not_credentials():
    text = read("src-tauri/src/feedback/mod.rs")
    status = re.search(r"pub struct DestinationStatus\s*\{([^}]+)\}", text, re.S)
    assert status and re.findall(r"pub\s+(\w+)\s*:", status[1]) == ["configured"]
    commands = read("src-tauri/src/feedback/commands.rs")
    assert not re.search(r"(?:emit|Event|Channel)[<(]", commands)
    assert not re.search(r"Result<\s*(?:SecretDestination|Value)", commands)
    ipc = read("src/lib/ipc.ts")
    assert "export interface FeedbackDestinationStatus { configured: boolean }" in ipc
    section = read("src/components/feedback/FeedbackDestinationSection.tsx")
    assert not re.search(r"useState[^\n]*(?:token|destination|apiKey)", section, re.I)


def test_capture_uses_the_trusted_calling_webview_and_never_writes_an_image_to_disk():
    windows = read("src-tauri/src/feedback/capture_windows.rs")
    macos = read("src-tauri/src/feedback/capture_macos.rs")
    commands = read("src-tauri/src/feedback/commands.rs")
    signature = re.search(r"pub async fn feedback_capture_main\((.*?)\)\s*->", commands, re.S)
    assert signature and re.search(r"webview:\s*tauri::Webview\b", signature[1])
    assert "webview.label()" in commands
    for text in (windows, macos):
        assert "get_webview(label)" in text
        assert 'get_webview("main")' not in text
    assert "Page.captureScreenshot" in windows
    assert "takeSnapshotWithConfiguration_completionHandler" in macos
    assert "crate::mac_webview::with_webview" in macos
    for text in (windows, macos):
        assert not re.search(r"BitBlt|CopyFromScreen|CGDisplay|screencapture|std::fs|File::create", text)

def test_feedback_response_is_bounded_while_streaming_at_one_mebibyte():
    text = read("src-tauri/src/feedback/transport.rs")
    assert re.search(r"MAX_RESPONSE_BYTES:\s*usize\s*=\s*(?:1024\s*\*\s*1024|1\s*\*\s*1024\s*\*\s*1024)", text)
    assert "response.chunk().await" in text
    assert "response.bytes().await" not in text


def test_feedback_permissions_are_in_the_generated_local_app_set():
    import json
    import tomllib

    permissions = tomllib.loads(read("src-tauri/permissions/app-local.toml"))
    local_sets = [entry for entry in permissions["set"] if entry["identifier"] == "app-local"]
    assert len(local_sets) == 1
    expected = {"allow-" + command.replace("_", "-") for command in COMMANDS}
    actual = set(local_sets[0]["permissions"])
    assert expected <= actual, sorted(expected - actual)
    manifest = json.loads(read("src-tauri/gen/schemas/acl-manifests.json"))["__app-acl__"]
    assert expected <= set(manifest["permission_sets"]["app-local"]["permissions"])
    for command in COMMANDS:
        for mode in ("allow", "deny"):
            identifier = mode + "-" + command.replace("_", "-")
            assert manifest["permissions"][identifier]["commands"][mode] == [command]


def test_feedback_acl_keeps_children_out_and_requires_trusted_callers():
    import json

    child = json.loads(read("src-tauri/capabilities/web-pane.json"))
    assert all("feedback" not in permission for permission in child["permissions"])
    assert "app-local" not in child["permissions"]
    commands = read("src-tauri/src/feedback/commands.rs")
    for command in COMMANDS:
        signature = re.search(r"pub async fn " + command + r"\((.*?)\)\s*->", commands, re.S)
        assert signature, command
        assert re.search(r"\b_trusted:\s*TrustedAppCaller\b", signature[1]), command
