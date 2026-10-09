"""The settings-only ACP route must not change ordinary PTY agents or own credentials."""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


def test_flag_is_off_and_the_trial_is_independent_of_the_pty_kind_allowlist():
    settings = source("src/stores/settingsStore.ts")
    assert "dshAcpExperimentEnabled: false" in settings
    assert "<DshAcpSection />" in source("src/components/settings/tabs/AiTab.tsx")
    for path in ["src/types/workspace.ts", "src/components/layout/socketCommands.ts", "src/lib/agents.ts",
                 "src/components/dashboard/dashboardModel.ts", "src-tauri/src/launcher.sh", "src-tauri/src/launcher.ps1"]:
        assert not re.search(r"['\"]dsh['\"]", source(path)), path
    assert 'if (!enabled) return <>{switchControl}' in source("src/components/settings/tabs/DshAcpSection.tsx")


def test_start_uses_an_explicit_local_path_with_no_package_acquisition_or_shell_fallback():
    transport = source("src-tauri/src/dsh_acp/mod.rs")
    assert 'Command::new(executable)' in transport and '.arg("acp")' in transport
    assert 'path.is_absolute()' in transport and 'path.is_file()' in transport
    assert '["cmd", "bat", "ps1"]' in transport
    for banned in ['Command::new("npx")', 'Command::new("npm")', '@deepseek-ai/dsh@latest', '.arg("latest")',
                   'reqwest::', 'SessionManager', 'create_pty', 'write_to_session']:
        assert banned not in transport, banned
    assert 'PINNED_VERSION: &str = "0.2.0-rc.2"' in transport


def test_dedicated_commands_are_async_registered_and_do_not_extend_v1_operations():
    transport = source("src-tauri/src/dsh_acp/mod.rs")
    commands = re.findall(r"#\[tauri::command\]\s+pub async fn (dsh_acp_\w+)", transport)
    assert len(commands) == 9
    registered = source("src-tauri/src/lib.rs")
    assert '.manage(dsh_acp::DshAcpState::default())' in registered
    for command in commands:
        assert "dsh_acp::" + command + "," in registered
    api = source("src/lib/agentAdapterApi.ts")
    operation_type = re.search(r"export type AdapterOperation = ([^;]+);", api).group(1)
    assert len(re.findall(r'"[^"]+"', operation_type)) == 8
    assert "closeSession" not in operation_type
    assert 'from "./agentAdapterApi"' in source("src/lib/ipc.ts")


def test_settings_and_api_have_only_references_not_credential_fields():
    settings = source("src/stores/settingsStore.ts")
    dsh_fields = set(re.findall(r"^  (dshAcp\w+):", settings, re.M))
    assert dsh_fields == {"dshAcpExperimentEnabled", "dshAcpExecutablePath", "dshAcpHomePath", "dshAcpSavedRun"}
    request = source("src-tauri/src/dsh_acp/mod.rs").split("pub struct DshStartRequest {")[1].split("}", 1)[0]
    assert set(re.findall(r"pub (\w+):", request)) == {"executable", "cwd", "dsh_home", "resume"}
    section = source("src/components/settings/tabs/DshAcpSection.tsx")
    assert 'type="password"' not in section
    assert "JSON.stringify" not in section
    assert "stopDshOwnedProcess(run)" in section
    assert "acceptedAtMs: null" in source("src/lib/agentAdapterApi.ts")


def test_child_identity_credentials_and_raw_diagnostics_are_not_forwarded_or_logged():
    transport = source("src-tauri/src/dsh_acp/mod.rs")
    assert 'name.starts_with("MYCMUX_")' in transport and 'name.starts_with("__CMUX_")' in transport
    assert 'name.starts_with("CODEX_")' in transport and '"API_KEY"' in transport
    assert 'command.env_remove(key)' in transport
    assert 'command.env("DSH_HOME", home)' in transport
    assert 'stderr.read(&mut chunk)' in transport
    assert not re.search(r'\b(eprintln!|println!|log::|tracing::)', transport)
    assert "read_to_string" not in transport and ".credentials.yaml" not in transport
    assert '"unsupported by mycmux dsh experiment"' in transport
    assert 'remote details withheld' in transport


def test_read_delivery_and_ownership_keep_acp_semantics():
    protocol = source("src-tauri/src/dsh_acp/protocol.rs")
    assert 'source: "acpUpdates"' in protocol and 'history_available: false' in protocol
    assert "MAX_UPDATES: usize = 128" in protocol
    assert "accepted_at_ms: None" in protocol
    assert 'delivery.status = "unknown"' in protocol
    assert 'no new-session fallback' in source("src-tauri/src/dsh_acp/mod.rs")
    assert "expected_run: DshRunRef" in source("src-tauri/src/dsh_acp/mod.rs")
    assert "dsh_codex_child_ancestry_is_not_a_registered_codex_pane" in source("src-tauri/src/dsh_acp/tests.rs")


def test_offline_fake_child_wire_records_prompt_permission_cancel_and_close_separately():
    fixture = ROOT / "tests/fixtures/dsh-acp/fake_dsh.py"
    version = subprocess.run([sys.executable, str(fixture), "--version"], capture_output=True, text=True, check=True, timeout=10)
    assert version.stdout.strip() == "0.2.0-rc.2"
    messages = [
        dict(id="initialize", method="initialize", params={}),
        dict(id="new", method="session/new", params={}),
        dict(id="text", method="session/prompt", params=dict(prompt=[dict(text="hello")])),
        dict(id="permission", method="session/prompt", params=dict(prompt=[dict(text="permission")])),
        dict(id=77, result=dict(outcome=dict(outcome="selected", optionId="reject-once"))),
        dict(id="cancelled", method="session/prompt", params=dict(prompt=[dict(text="cancel")])),
        dict(method="session/cancel", params={}),
        dict(id="close", method="session/close", params={}),
    ]
    completed = subprocess.run([sys.executable, str(fixture), "acp"],
                               input="".join(json.dumps(dict(jsonrpc="2.0", **message)) + "\n" for message in messages),
                               capture_output=True, text=True, check=True, timeout=10)
    frames = [json.loads(line) for line in completed.stdout.splitlines()]
    assert all(frame["jsonrpc"] == "2.0" for frame in frames)
    assert len([frame for frame in frames if frame.get("method") == "session/request_permission"]) == 1
    replies = {frame["id"]: frame["result"] for frame in frames if "result" in frame}
    assert replies["text"]["stopReason"] == "end_turn"
    assert replies["permission"]["stopReason"] == "end_turn"
    assert replies["cancelled"]["stopReason"] == "cancelled"
    assert replies["close"] == {}


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print("PASS " + test.__name__)
    print(str(len(tests)) + " contract tests passed (direct Python; pytest not invoked)")
