"""Fail-closed contracts for future data.json schema versions."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def test_rust_load_returns_a_tagged_nullable_envelope() -> None:
    storage = read_repo_text("src-tauri/src/db/storage.rs")
    command = read_repo_text("src-tauri/src/commands/workspace.rs")
    ipc = read_repo_text("src/lib/ipc.ts")

    for snippet in (
        "pub struct PersistentDataEnvelope",
        '#[serde(rename_all = "camelCase")]',
        "pub schema_version: u32",
        "pub data: Option<PersistentData>",
        "pub supported: bool",
    ):
        assert snippet in storage
    assert "Result<PersistentDataEnvelope, String>" in command
    assert "Promise<PersistentDataEnvelope>" in ipc
    assert 'invoke<PersistentDataEnvelope>("load_persistent_data")' in ipc


def test_unsupported_startup_diagnostic_copy() -> None:
    source = read_repo_text("src/lib/persistenceStrings.ts")
    assert "対応していない保存データ" in source


def test_all_frontend_persistence_starts_fail_closed() -> None:
    coordinator = read_repo_text("src/lib/workspacePersistenceCoordinator.ts")

    for snippet in (
        'status: "pending"',
        "markPersistentSchemaSupported",
        "quarantinePersistentSchema",
        "isPersistenceWriteAllowed",
    ):
        assert snippet in coordinator


def test_save_rejection_preserves_typed_error_and_diagnostic() -> None:
    storage = read_repo_text("src-tauri/src/db/storage.rs")
    command = read_repo_text("src-tauri/src/commands/workspace.rs")
    ipc = read_repo_text("src/lib/ipc.ts")
    listener = read_repo_text("src/lib/persistenceStrings.ts")

    assert "pub enum PersistentStorageError" in storage
    assert "UnsupportedSchema" in storage
    assert "Result<(), storage::PersistentStorageError>" in command
    assert "unsupportedPersistentSchemaVersion" in ipc
    assert "対応していない保存データ" in listener


def test_child_window_diagnostic_copy() -> None:
    source = read_repo_text("src/lib/persistenceStrings.ts")
    assert "対応していない保存データ" in source


# The former test_remote_setting_is_persisted_before_runtime_side_effects
# guarded the built-in phone server's enable toggle, which was removed with
# that server in 2026-09. The phone entry is read-only (no persisted setting),
# so there is no persist-before-side-effect ordering left to guard.


def test_round_three_terminal_errors_are_typed_and_non_retryable() -> None:
    storage = read_repo_text("src-tauri/src/db/storage.rs")
    ipc = read_repo_text("src/lib/ipc.ts")
    listener = read_repo_text("src/lib/persistenceStrings.ts")
    for snippet in ("UnsupportedPlatform", '"unsupportedPlatform"'):
        assert snippet in storage
    assert "nonRetryablePersistentStorageError" in ipc
    assert "保存せずに終了しますか" in listener


def test_round_four_terminal_writers_project_typed_errors_into_quarantine() -> None:
    coordinator = read_repo_text("src/lib/workspacePersistenceCoordinator.ts")
    ailog = read_repo_text("src/stores/ailogStore.ts")
    storage = read_repo_text("src-tauri/src/db/storage.rs")

    # RemoteTab was the third writer here until the built-in phone server was
    # removed (2026-09); its replacement, PocketTab, writes no setting.
    assert "quarantineTerminalPersistentStorageError" in coordinator
    assert "quarantineTerminalPersistentStorageError" in ailog
    constructor = storage.index("fn unsupported_platform")
    assert "#[cfg(any(test, not(windows)))]" in storage[max(0, constructor - 80) : constructor]


def test_retention_reprobes_before_any_gc_and_logs_a_durable_abort() -> None:
    source = read_repo_text("src-tauri/src/session_retention.rs")
    body = source[source.index("fn run_retention_once(") : source.index("fn collect_live_sessions(")]
    probe = "collect_live_sessions(&roots.app_data_parent)"
    assert body.count(probe) >= 2
    second_probe = body.rindex(probe)
    for destructive in ("scrollback_store::gc", "retain_directory_records", "retain_pane_session_files"):
        assert second_probe < body.index(destructive)
    startup = source[source.index("pub fn run_startup_retention") : source.index("fn run_retention_once(")]
    assert "diag_warn!(" in startup
    assert '"session_retention"' in startup


def test_round_three_writer_commands_preserve_typed_storage_errors() -> None:
    # The remote server's set_remote_enabled was the bool-returning half of
    # this contract; it went away with that server in 2026-09.
    ailog = read_repo_text("src-tauri/src/commands/ailog.rs")
    assert "Result<f64, crate::db::storage::PersistentStorageError>" in ailog


def test_test_mutex_is_process_scoped_and_dead_preflight_helpers_are_test_only() -> None:
    storage = read_repo_text("src-tauri/src/db/storage.rs")
    assert "data-json-test-" in storage
    for name in (
        "fn schema_version_from_path",
        "fn ensure_existing_schema_supported",
        "fn save_to_path",
    ):
        index = storage.index(name)
        assert "#[cfg(test)]" in storage[max(0, index - 40) : index]


def test_plan_scopes_byte_preservation_to_data_json_not_local_storage() -> None:
    plan = read_repo_text("docs/plans/2026-08-26-datajson-schema-guard.md")
    assert "localStorage" in plan
    assert "data.json" in plan
    assert "対象外" in plan


def test_web_automation_options_are_absent_from_projected_json() -> None:
    import json
    import subprocess

    script = """
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const path = require('node:path');
const filename = path.resolve('src/lib/persistentLayoutProjection.ts');
const source = fs.readFileSync(filename, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const moduleUnderTest = new Module(filename);
moduleUnderTest._compile(compiled.outputText, filename);
const tab = { id: 'web', sessionId: 'session', agentId: 'web', type: 'web',
  presetId: 'chatgpt', webBackground: true, webInitialUrl: 'https://chatgpt.com/c/private' };
console.log(JSON.stringify(moduleUnderTest.exports.persistentTabProjection(tab)));
"""
    result = subprocess.run(
        ["node", "-e", script], cwd=REPO_ROOT, capture_output=True, text=True,
        encoding="utf-8", check=True,
    )
    projected = json.loads(result.stdout)
    assert projected["presetId"] == "chatgpt"
    assert "webBackground" not in projected
    assert "webInitialUrl" not in projected
    assert "private" not in result.stdout
