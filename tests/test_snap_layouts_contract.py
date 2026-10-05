"""Snap Layouts must stay async, local to its own window and Windows-only."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RUST = (ROOT / 'src-tauri/src/snap_layouts.rs').read_text(encoding='utf-8')
LIB = (ROOT / 'src-tauri/src/lib.rs').read_text(encoding='utf-8')
UI = (ROOT / 'src/components/layout/WindowControls.tsx').read_text(encoding='utf-8')

def test_async_command_cannot_select_another_window():
    signature = re.search(r'pub async fn snap_layouts_update\((.*?)\) ->', RUST, re.S).group(1)
    assert 'window: tauri::WebviewWindow' in signature
    assert 'label:' not in signature and 'hwnd:' not in signature
    assert 'crate::tearout::on_ui(&app' in RUST
    assert 'snap_layouts::snap_layouts_update,' in LIB

def test_native_module_and_ui_are_windows_only():
    assert '#[cfg(target_os = "windows")]\nmod native' in RUST
    assert '#[cfg(not(target_os = "windows"))]' in RUST
    assert 'if (!/Win/i.test(navigator.platform)) return;' in UI
    assert 'SetWindowLongPtrW(' not in RUST
    assert 'set_focusable(' not in RUST and 'set_decorations(' not in RUST

def test_preserves_existing_hit_tests_and_os_hover_processing():
    assert 'hit_test(state.pixels.get(), point.x, point.y, baseline.0)' in RUST
    assert 'return baseline;' in RUST
    assert 'HTTRANSPARENT as isize' in RUST and 'HTMAXBUTTON' in RUST
    assert 'DefSubclassProc(parent, msg, w, l)' in RUST
    assert 'SC_RESTORE' in RUST and 'SC_MAXIMIZE' in RUST

def test_cleanup_has_one_owned_reference_and_partial_install_rollback():
    assert 'Rc::into_raw(state.clone())' in RUST
    assert 'Rc::increment_strong_count(ptr)' in RUST
    assert 'if state.installed.replace(false)' in RUST
    assert 'WM_NCDESTROY' in RUST and 'RemoveWindowSubclass' in RUST
    assert re.search(r'clear_child\(&state\);\s*unsafe\s*\{\s*drop\(Rc::from_raw\(context\)\);', RUST)
    assert 'snap_layouts::window_destroyed(window.label())' in LIB
    assert re.search(r'if first\s*\{\s*crate::diag::warn', RUST)

def test_profile_failure_injection_cannot_affect_production():
    assert 'if crate::test_profile::is_active()' in RUST
    assert 'tokio::fs::read_to_string' in RUST
    assert 'snap-layouts-test-failure.txt' in RUST
    assert 'failure == "create"' in RUST and 'failure == "subclass"' in RUST

def test_event_and_unmount_ownership_are_scoped():
    assert 'EventTarget::window(self.window.label())' in RUST
    assert 'payload.owner === owner' in UI
    assert 'updateNative(owner, null)' in UI
    assert 'nativeUpdates.catch(() => {})' in UI
    assert 'getCurrentWindow().toggleMaximize()' in UI

def test_focus_loss_and_detach_do_not_release_an_os_caption_move_capture():
    assert 'if had_press && GetCapture() == parent' in RUST
    assert 'if had_press && unsafe { GetCapture() } == parent' in RUST
    assert 'let had_press = button.cancel();' in RUST


def test_dom_measurements_rebase_integer_webview_extent_on_native_client():
    assert 'fn measured(mut self, width: i32, height: i32, scale: f64)' in RUST
    assert 'self.viewport_width = width as f64 / scale;' in RUST
    assert 'self.viewport_height = height as f64 / scale;' in RUST
    assert 'r.measured(client.right, client.bottom, scale)' in RUST
    assert 'GetClientRect(parent, &mut client)' in RUST
