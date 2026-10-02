"""Source contracts for the Windows-only, opt-in single-tab drag route."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(relative):
    return (ROOT / relative).read_text(encoding="utf-8")


def test_off_route_and_non_tab_routes_remain_legacy():
    entry = read("src/hooks/usePaneDragSource.ts")
    pointer = read("src/lib/tearout/pointerDrag.ts")
    settings = read("src/stores/settingsStore.ts")
    feature = read("src/lib/tearout/feature.ts")
    assert "nativePaneTearoutEnabled: false" in settings
    assert 'item.kind === "tab" && usesNativePaneDrag(item)' in entry
    assert 'item.kind !== "tab" || item.surface === "minimap"' in pointer
    assert "supportsNativePaneTearout" in feature and "Win" in feature
    assert "commitPaneDragDrop" in entry and "beginDrag" in entry
    assert "detach" in entry


def test_new_children_only_use_fresh_reservations():
    backend = read("src-tauri/src/tearout/mod.rs")
    assert "resolve_child_window_label(&app, None)" in backend
    assert "ResolvedChildWindow::New(r)" in backend
    assert re.search(r"\.visible\(false\)\s*\.focused\(false\)", backend)
    assert "set_close_intent(&label, true)" in backend


def test_opted_in_legacy_detached_windows_have_the_common_receiver_surface():
    entry = read("src/App.tsx")
    shell = read("src/components/layout/NativePaneShell.tsx")
    assert "usesNativePaneShell(isTearoutChild(), detachedWorkspace !== null, nativeTearoutEnabled)" in entry
    assert "<WorkspaceView />" in shell and "<PaneDragOverlay />" in shell
    assert "<DetachedPaneShell workspace={detachedWorkspace} />" in entry


def test_failed_preparation_cleans_up_only_the_still_owned_spare_on_the_ui_thread():
    source = read("src-tauri/src/tearout/mod.rs")
    failure = source.split("if let Err(error) = result {", 1)[1].split("Ok(Some(label))", 1)[0]
    assert "failed_label == &label" in failure and "*ready = false" in failure
    assert "on_ui(&app, move |app|" in failure
    assert "window.destroy()" in failure
    assert failure.index("window.destroy()") < failure.index("*spare = None")
    assert "tearout_spare_cleanup_failed" in failure


def test_all_new_commands_are_async_and_use_window_not_webviewwindow():
    source = read("src-tauri/src/tearout/mod.rs")
    commands = re.findall(r"#\[tauri::command\]\s+([^\n]+)", source)
    assert commands and all(command.startswith("pub async fn ") for command in commands)
    assert "window: tauri::Window" in source
    assert "window: tauri::WebviewWindow" not in source


def test_native_code_is_windows_gated_and_window_apis_are_capable():
    source = read("src-tauri/src/tearout/mod.rs")
    assert '#[cfg(target_os = "windows")]\nmod native;' in source
    assert "windows::Win32" not in source
    capabilities = read("src-tauri/capabilities/default.json")
    for api in ("allow-show", "allow-start-dragging", "allow-destroy", "allow-set-position", "allow-set-size"):
        assert f"core:window:{api}" in capabilities
    assert '"mycmux-w*"' in capabilities


def test_existing_drop_zone_geometry_is_reused():
    dock = read("src/stores/detachedDockStore.ts")
    runtime = read("src/lib/tearout/runtime.ts")
    native = read("src-tauri/src/tearout/native.rs")
    assert "resolvePaneDropZone(pane.getBoundingClientRect(), x, y, previousZone)" in dock
    assert "detachedDockTarget(" in runtime
    assert "ClientToScreen" in native and "GetDpiForWindow" in native
    assert "SW_SHOWNOACTIVATE" in native and "SetLayeredWindowAttributes" in native


def test_live_transfer_attachment_has_no_spawn_branch():
    backend = read("src-tauri/src/tearout/mod.rs")
    attachment = backend.split("pub async fn tearout_attach(", 1)[1].split("#[tauri::command]", 1)[0]
    assert re.search(r"session_manager\s*\.get\(&session_id\)", attachment)
    assert "replace_data_channel(on_data)" in attachment
    assert ".create(" not in attachment and "spawn(" not in attachment


def test_escape_waits_for_native_exit_and_hidden_spares_do_not_keep_app_alive():
    native = read("src-tauri/src/tearout/native.rs")
    wiring = read("src-tauri/src/lib.rs")
    assert "WM_ENTERSIZEMOVE" in native and "WM_EXITSIZEMOVE" in native
    assert "WH_KEYBOARD" in native and "GetAsyncKeyState(VK_ESCAPE" in native
    assert "Do not restore/destroy a window while its OS move loop still owns it" in native
    assert "release_idle_after_destroy" in wiring
