from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_transfer_archive_is_fixed_atomic_and_runs_off_the_ui_thread() -> None:
    transfer = read("src-tauri/src/commands/online/transfer.rs")
    lib_rs = read("src-tauri/src/lib.rs")
    capability = read("src-tauri/capabilities/default.json")

    for entry in (
        'const TRANSFER_ENTRY: &str = "transfer.json";',
        'const MANIFEST_ENTRY: &str = "bundle/manifest.json";',
        'const HANDOFF_ENTRY: &str = "bundle/handoff.md";',
        'const TRANSCRIPT_ENTRY: &str = "bundle/transcript/session.jsonl";',
    ):
        assert entry in transfer
    # The archive is built into a temp file beside the destination and renamed
    # over it only after fsync; util::atomic_write owns those steps now.
    assert 'AtomicWrite::new("transfer file", "Failed to save transfer file")' in transfer
    assert ".write_with(destination_path, |temp_file|" in transfer
    assert "tempdir_in(local_dir)" in transfer
    # run_blocking wraps tauri::async_runtime::spawn_blocking.
    assert 'run_blocking("export_savepoint_transfer"' in transfer
    assert 'run_blocking("import_savepoint_transfer"' in transfer
    assert "ZipArchive::extract" not in transfer
    assert "transfer_digest(&envelope)" in transfer
    assert "is_link_or_reparse_point" in transfer
    assert "commands::online::transfer::export_savepoint_transfer" in lib_rs
    assert "commands::online::transfer::import_savepoint_transfer" in lib_rs
    assert '"dialog:default"' in capability


def test_transfer_file_drop_is_intercepted_before_terminal_path_paste() -> None:
    app = read("src/App.tsx")
    drop_handler = app.split("onDragDropEvent(async (event) =>", 1)[1].split(
        "const refreshAgentSessionMappings", 1
    )[0]

    transfer_index = drop_handler.index("isSavepointTransferPath(paths[0])")
    assert transfer_index < drop_handler.index('closest("[data-session-id]")')
    assert transfer_index < drop_handler.index("await isDirectory(paths[0])")
    transfer_branch = drop_handler[transfer_index : drop_handler.index("// Convert physical pixels")]
    assert "await receiveSavepointTransfer(paths[0])" in transfer_branch
    assert "return;" in transfer_branch
    assert "transferReceiveErrorPrefix" in transfer_branch


def test_panel_exposes_only_simple_receive_and_share_routes() -> None:
    panel = read("src/components/online/OnlinePanel.tsx")
    transfer_helper = read("src/lib/savepointTransfer.ts")

    assert "chooseAndReceiveSavepointTransfer" in panel
    assert "shareSavepointTransfer(entry.bundle_dir, entry.summary_line)" in panel
    assert "SAVEPOINT_RECEIVED_EVENT" in panel
    assert 'data-savepoint-transfer-drop="true"' in panel
    assert 'data-savepoint-export-target="true"' in panel
    assert "result.imported" in panel
    assert "useOnlineSavepointStore.getState().refresh()" in transfer_helper
    assert "window.dispatchEvent(new CustomEvent(SAVEPOINT_RECEIVED_EVENT" in transfer_helper
    assert "one-time" not in panel.lower()
    assert "receive code" not in panel.lower()
