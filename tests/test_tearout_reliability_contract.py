"""Cross-language transfer safety boundaries; runtime fault coverage lives in Vitest."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def source(path):
    return (ROOT / path).read_text(encoding="utf-8")
def test_lifecycle_moves_do_not_add_a_spawn_path():
    runtime = source("src/lib/tearout/runtime.ts")
    assert "createSession(" not in runtime and "killSession(" not in runtime
    assert "liveSessions = await liveTransferSessions([config])" in runtime
    assert runtime.index("liveSessions = await liveTransferSessions([config])") < runtime.index('await invoke("tearout_prepare", { id, receiver: label')
    sessions = source("src/lib/tearout/transferSessions.ts")
    assert 'tab.lifecycle === "declared"' in sessions
    assert "started.map(isSessionAlive)" in sessions

def test_legacy_window_label_is_not_a_receipt():
    legacy = source("src/lib/workspaceTearOut.ts")
    assert legacy.index("await waitForTearoutReceiver(label)") < legacy.index("removeWorkspace(workspaceId)")
    assert legacy.index("await sendTearoutWorkspaces(") < legacy.index('phase: "received"')
    assert "deferredAdoption: true" in legacy
    registry = source("src-tauri/src/commands/window_registry.rs")
    assert "deferred_adoption: Option<bool>" in registry
    assert "if !deferred { state.window_registry.queue_adoption(&label, workspaces); }" in registry
    assert "spawn_child_window(&app, reservation" in registry

def test_release_and_failure_diagnostics_cross_the_rust_boundary():
    record = source("src/lib/tearout/record.ts")
    rust = source("src-tauri/src/tearout/log.rs")
    assert "this.data.released_at = this.data.layout_done_at" not in record
    for key in ("failure_reason", "failure_phase", "failed_session_ids", "released"):
        assert key in record and key in rust
    for outcome in ("RejectedBusy", "RestoreFailed"):
        assert outcome in rust
    assert "deny_unknown_fields" in rust
    assert "record.released_at.is_some()" in rust
