from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_trash_commands_are_wired_through_tauri_and_frontend():
    lib_rs = read("src-tauri/src/lib.rs")
    ipc = read("src/lib/ipc.ts")
    savepoints = read("src/components/online/onlineSavepoints.ts")

    for command in (
        "list_trashed_online_savepoints",
        "restore_online_savepoint",
        "purge_online_savepoint",
    ):
        assert f"commands::online::{command}" in lib_rs
    assert 'invoke<OnlineSavepointEntry[]>("list_trashed_online_savepoints")' in ipc
    assert 'invoke("delete_online_savepoint", { bundleDir })' in savepoints
    assert 'invoke("restore_online_savepoint", { bundleDir, trashId })' in savepoints
    assert 'invoke("purge_online_savepoint", { bundleDir, trashId })' in savepoints


def test_trash_view_disables_handoff_and_keeps_permanent_delete_confirmed():
    panel = read("src/components/online/OnlinePanel.tsx")
    strings = read("src/components/online/onlineStrings.ts")

    assert 'const [view, setView] = useState<SavepointListView>("active")' in panel
    assert "const loadGenerationRef = useRef(0)" in panel
    # Active and trashed lists must fail independently: each side resolves to
    # null on error (store refresh / inline rejection handler) instead of one
    # rejection discarding the other list.
    assert "useOnlineSavepointStore.getState().refresh()" in panel
    assert "activeEntries ? onlineStrings.trashLoadError : onlineStrings.loadError" in panel
    assert "generation !== loadGenerationRef.current" in panel
    assert 'onPointerDown={trashed ? undefined' in panel
    assert "{!trashed && (" in panel
    assert "trashed ? (" in panel
    assert "restoreEntry(entry)" in panel
    assert "purgeEntry(entry)" in panel
    assert "armedDeleteBundle !== entry.bundle_dir" in panel
    assert 'moveToTrash: "ゴミ箱へ"' in strings
    assert 'restore: "元に戻す"' in strings
    assert 'deletePermanently: "完全に削除"' in strings


def test_backend_uses_a_separate_trash_container_and_id_validation():
    online_rs = "\n".join(
        [
            read("src-tauri/src/commands/online.rs"),
            read("src-tauri/src/commands/online/lifecycle.rs"),
        ]
    )

    assert 'pub(crate) const TRASH_DIR: &str = "_trash";' in online_rs
    assert "fs::rename(&bundle_dir, &target)" in online_rs
    assert "trash.id == expected_trash_id" in online_rs
    assert "A savepoint already exists at the restore destination" in online_rs
    assert "matching_closed_head(" in online_rs
    assert "shadow_manifest.identity()? != *identity" in online_rs
