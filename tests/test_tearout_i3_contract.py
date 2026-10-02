"""Contracts for the native group routes, receiver isolation and test probes."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return (ROOT / name).read_text(encoding="utf-8")


def test_group_routes_are_opt_in_without_replacing_the_old_pane_route():
    hook = read("src/hooks/usePaneDragSource.ts")
    pointer = read("src/lib/tearout/pointerDrag.ts")
    sidebar = read("src/components/layout/TabBar.tsx")
    assert 'item.kind === "tab" && usesNativePaneDrag(item)' in hook
    assert 'item.kind === "pane" && usesNativeGroupDrag(item)' in hook
    assert "beginNativeGroupDrag" in hook
    assert "nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled)" in pointer
    assert "beginNativeWorkspaceDrag" in sidebar
    assert "tearOutWorkspaceToNewWindow(workspace.id" in sidebar
    assert "reorder(dragIndex, dropIndex)" in sidebar
    assert "supportsNativePaneTearout" in read("src/lib/tearout/feature.ts")


def test_all_window_state_events_and_temporary_native_listeners_are_targeted():
    runtime = read("src/lib/tearout/runtime.ts")
    assert 'listen<NativeSample>("mycmux://tearout-native", ({ payload }) => handleNativeSample(payload), ownWindow)' in runtime
    for event in ("DELIVERY", "RECEIPT", "OUTGOING", "REVOKE", "FINALIZE"):
        assert re.search(r"listen(?:<[^\n]+>)?\(" + event + r",[^\n]+, ownWindow\)", runtime)
    assert runtime.count('target: { kind: "Window" as const, label: windowLabel() }') >= 1
    assert 'emit_to' in read("src-tauri/src/tearout/native.rs")
    assert 'app.emit("mycmux://tearout-native"' not in read("src-tauri/src/tearout/native.rs")


def test_synthetic_sampling_is_async_and_rejects_the_live_profile():
    source = read("src-tauri/src/tearout/mod.rs")
    command = source.split("pub async fn tearout_synthetic_sample(", 1)[1].split("#[tauri::command]", 1)[0]
    assert "if !crate::test_profile::is_active()" in command
    assert "tearout_synthetic_requires_test_profile" in command
    assert '#[cfg(target_os = "windows")]' in command
    assert "on_ui(&app" in command
    assert "window: tauri::WebviewWindow" not in source
    commands = re.findall(r"#\[tauri::command\]\s+([^\n]+)", source)
    assert all(command.startswith("pub async fn ") for command in commands)


def test_new_native_window_calls_have_capabilities_and_keep_win32_gated():
    capability = read("src-tauri/capabilities/default.json")
    for permission in ("allow-start-dragging", "allow-set-size", "allow-set-position", "allow-destroy"):
        assert f'"core:window:{permission}"' in capability
    assert '"mycmux-w*"' in capability
    assert '#[cfg(target_os = "windows")]\nmod native;' in read("src-tauri/src/tearout/mod.rs")


def test_transport_metadata_has_no_terminal_content_fields():
    record = read("src/lib/tearout/record.ts")
    backend = read("src-tauri/src/tearout/log.rs")
    assert "grabbed_kind" in record and "pane_count" in record
    assert "grabbed_kind" in backend and "pane_count" in backend
    struct = backend.split("pub struct DragRecord {", 1)[1].split("\n}", 1)[0]
    assert not any(field in struct for field in ("command_argv", "terminal_snapshot", "launch_env", "scrollback", "token:"))
