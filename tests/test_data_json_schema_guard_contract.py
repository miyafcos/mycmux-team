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


def test_frontend_checks_schema_before_any_hydration_or_session_mapping_read() -> None:
    source = read_repo_text("src/components/layout/SocketListener.tsx")
    envelope = source.index("loadPersistentData().then(async (envelope)")
    quarantine = source.index("reportUnsupportedPersistentSchema", envelope)
    mapping_read = source.index("readAgentSessionMappings", envelope)
    theme_hydrate = source.index("hydrateSettings", envelope)
    workspace_restore = source.index("restoreWorkspaceConfigs", envelope)

    assert envelope < quarantine < mapping_read
    assert quarantine < theme_hydrate
    assert quarantine < workspace_restore
    assert "対応していない保存データ" in source


def test_supported_schema_is_published_only_after_full_hydration_and_restore() -> None:
    source = read_repo_text("src/components/layout/SocketListener.tsx")
    envelope = source.index("loadPersistentData().then(async (envelope)")
    mapping_read = source.index("readAgentSessionMappings", envelope)
    ai_hydrate = source.index("hydrateAiSettingsFromDataJson", envelope)
    startup_hold = source.index("startupAutosaveHoldUntil.current", envelope)
    workspace_restore = source.index("restoreWorkspaceConfigs", envelope)
    hydration_barrier = source.index("publishPersistentSchemaAfterHydration", envelope)
    loaded = source.index("_resolveLoaded()", hydration_barrier)

    assert hydration_barrier < mapping_read < ai_hydrate < startup_hold < workspace_restore < loaded
    helper = source[
        source.index("export async function publishPersistentSchemaAfterHydration") : envelope
    ]
    assert helper.index("await hydrate()") < helper.index("markPersistentSchemaSupported")


def test_all_frontend_persistence_starts_fail_closed() -> None:
    coordinator = read_repo_text("src/lib/workspacePersistenceCoordinator.ts")
    listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in (
        'status: "pending"',
        "markPersistentSchemaSupported",
        "quarantinePersistentSchema",
        "isPersistenceWriteAllowed",
    ):
        assert snippet in coordinator
    assert "if (!isPersistenceWriteAllowed())" in listener


def test_save_rejection_is_typed_and_quarantines_before_retry() -> None:
    storage = read_repo_text("src-tauri/src/db/storage.rs")
    command = read_repo_text("src-tauri/src/commands/workspace.rs")
    ipc = read_repo_text("src/lib/ipc.ts")
    listener = read_repo_text("src/components/layout/SocketListener.tsx")

    assert "pub enum PersistentStorageError" in storage
    assert "UnsupportedSchema" in storage
    assert "Result<(), storage::PersistentStorageError>" in command
    assert "unsupportedPersistentSchemaVersion" in ipc
    catch = listener.index(".catch((err) =>", listener.index("savePersistentData(snapshot)"))
    quarantine = listener.index("reportUnsupportedPersistentSchema", catch)
    dirty = listener.index("dirty = true", catch)
    retry = listener.index("scheduleSaveRetry", catch)
    assert catch < quarantine < dirty < retry
    assert "対応していない保存データ" in listener


def test_child_window_surfaces_unsupported_schema_diagnostic() -> None:
    source = read_repo_text("src/components/layout/SocketListener.tsx")
    child = source[source.index("hydrateChildWindow()") : source.index("claimLeader()")]
    assert "unsupportedPersistentSchemaVersion" in child
    assert "reportUnsupportedPersistentSchema" in child
    assert "対応していない保存データ" in source


def test_remote_setting_is_persisted_before_runtime_side_effects() -> None:
    source = read_repo_text("src-tauri/src/remote/mod.rs")
    body = source[source.index("async fn apply_remote_enabled_transition") : source.index(
        "#[tauri::command(async)]\npub async fn set_remote_enabled"
    )]
    update = body.index("crate::db::storage::update")
    assert update < body.index("apply_runtime(bind_all).await")
    assert "data.settings.remote_enabled = previous_enabled" in body


def test_round_three_terminal_errors_are_typed_and_non_retryable() -> None:
    storage = read_repo_text("src-tauri/src/db/storage.rs")
    ipc = read_repo_text("src/lib/ipc.ts")
    listener = read_repo_text("src/components/layout/SocketListener.tsx")
    for snippet in ("UnsupportedPlatform", '"unsupportedPlatform"'):
        assert snippet in storage
    assert "nonRetryablePersistentStorageError" in ipc
    assert 'reason: "hydrationFailed"' in listener
    assert "保存せずに終了しますか" in listener


def test_round_four_terminal_writers_project_typed_errors_into_quarantine() -> None:
    coordinator = read_repo_text("src/lib/workspacePersistenceCoordinator.ts")
    remote = read_repo_text("src/components/settings/tabs/RemoteTab.tsx")
    ailog = read_repo_text("src/stores/ailogStore.ts")
    storage = read_repo_text("src-tauri/src/db/storage.rs")

    assert "quarantineTerminalPersistentStorageError" in coordinator
    assert "quarantineTerminalPersistentStorageError" in remote
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
    remote = read_repo_text("src-tauri/src/remote/mod.rs")
    ailog = read_repo_text("src-tauri/src/commands/ailog.rs")
    assert "Result<bool, crate::db::storage::PersistentStorageError>" in remote
    assert "Result<f64, crate::db::storage::PersistentStorageError>" in ailog
    assert "previous_enabled" in remote
    assert "apply_runtime" in remote


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
