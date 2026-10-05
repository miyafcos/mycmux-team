"""Windows tear-out placement must survive every automatic post-drag path."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def body(source, name):
    start = source.index("{", source.index("fn " + name + "("))
    depth = 0
    for index in range(start, len(source)):
        depth += (source[index] == "{") - (source[index] == "}")
        if not depth:
            return source[start:index + 1]
    raise AssertionError(name)


def test_windows_settle_only_changes_native_alpha_and_foreground_focus():
    settle = body(read("src-tauri/src/tearout/mod.rs"), "tearout_settle")
    assert 'native::set_alpha(&window, 255)?;' in settle
    assert '#[cfg(target_os = "windows")]\n                window.set_focus()' in settle
    assert '#[cfg(target_os = "macos")]\n                window.set_focusable(true)' in settle
    for forbidden in ("set_size", "set_position", "ShowWindow", "set_decorations"):
        assert forbidden not in settle


def test_native_regrab_changes_no_window_attribute_and_gates_docking_after_movement():
    source = read("src-tauri/src/tearout/native.rs")
    start = body(source, "start")
    for forbidden in ("set_focusable", "set_size", "set_position", "set_decorations", "SetWindowLongPtrW", "ShowWindow"):
        assert forbidden not in start
    assert 'window.start_dragging()' in start
    assert 'geometry::moved_for_dock' in start
    assert 'if polling.moved.load(Ordering::Acquire)' in start
    assert 'WS_EX_LAYERED' in body(source, "set_alpha")
    assert 'SetLayeredWindowAttributes' in body(source, "set_alpha")


def test_real_and_synthetic_receivers_apply_the_same_exterior_edge_filter():
    source = read("src-tauri/src/tearout/native.rs")
    assert 'geometry::snap_edge_reserved' in body(source, "receiver_at")
    synthetic = body(source, "synthetic_sample")
    assert 'geometry::snap_edge_reserved' in synthetic
    assert 'ClientToScreen' in synthetic and 'geometry::moved_for_dock' in synthetic
    assert 'GetMonitorInfoW' in body(source, "monitor_area")
    assert 'rcWork' in body(source, "monitor_area")


def test_escape_captures_and_restores_full_native_placement_without_tao_setters():
    source = read("src-tauri/src/tearout/native.rs")
    original = body(source, "geometry")
    for field in ("show_cmd", "normal", "min_position", "max_position", "flags"):
        assert field in original
    restore = body(source, "restore_geometry")
    assert "SetWindowPlacement" in restore
    assert "set_position" not in restore and "set_size" not in restore
    assert 'native::restore_geometry(&window, geometry)?' in read("src-tauri/src/tearout/mod.rs")


def test_saved_maximized_is_optional_and_only_windows_native_groups_write_it():
    source = read("src-tauri/src/db/storage.rs")
    assert '#[serde(default, skip_serializing_if = "Option::is_none")]\n    pub maximized: Option<bool>' in source
    save = body(read("src-tauri/src/commands/workspace.rs"), "attach_detached_window_frames")
    assert '#[cfg(target_os = "windows")]' in save
    assert 'group.native_tearout == Some(true)' in save
    assert 'Some(true)' in save and 'saved_native_frame' in save
    assert 'old_window_group_defaults_maximized_and_round_trips_without_new_field' in source
    assert 'maximized_group_survives_new_round_trip_and_old_reader_ignores_only_the_flag' in source


def test_saved_native_first_show_is_after_paint_and_preserves_the_maximized_flag():
    source = read("src-tauri/src/tearout/native.rs")
    show = body(source, "quiet_show")
    assert show.index('if !unsafe { IsWindowVisible') < show.index('SetWindowLongPtrW')
    assert 'WS_EX_NOACTIVATE' in show and 'SW_MAXIMIZE' in show
    assert 'SW_SHOWNOACTIVATE' not in source
    ready = body(read("src-tauri/src/tearout/mod.rs"), "tearout_child_ready")
    assert 'native::quiet_show(&window, maximized)' in ready
    constructor = body(read("src-tauri/src/commands/window.rs"), "spawn_child_window")
    assert 'prepare_restored_window' in constructor
    assert '.maximized(' not in constructor


def test_hidden_desktop_cursor_override_requires_an_active_profile_and_failed_native_read():
    cursor = body(read("src-tauri/src/tearout/native.rs"), "cursor")
    assert cursor.index('if let Err(error)') < cursor.index('test_profile::is_active()') < cursor.index('tearout-test-cursor.json')
    assert 'SetCursorPos' not in cursor


def test_saved_native_boot_fallback_uses_the_same_quiet_maximized_reveal():
    fallback = body(read("src-tauri/src/commands/window.rs"), "schedule_child_window_reveal_fallback")
    assert '#[cfg(target_os = "windows")]' in fallback and 'if native_restore' in fallback
    assert 'run_on_main_thread' in fallback and 'reveal_restored_fallback' in fallback
    native = body(read("src-tauri/src/tearout/mod.rs"), "reveal_restored_fallback")
    assert 'restored_windows' in native and 'native::quiet_show(window, maximized)' in native
    assert 'set_focusable' not in native and 'set_size' not in native and 'set_position' not in native


def test_quiet_reveal_vetoes_only_target_activation_and_releases_the_ui_thread_hook():
    source = read("src-tauri/src/tearout/native.rs")
    show = body(source, "quiet_show")
    assert show.index('if !unsafe { IsWindowVisible') < show.index('QuietShowActivation::new')
    callback = body(source, "quiet_activation")
    assert 'code == HCBT_ACTIVATE as i32' in callback and 'quiet.get() == target.0' in callback
    assert 'LRESULT(1)' in callback and 'CallNextHookEx(None, code, target, data)' in callback
    assert 'SetWindowsHookExW(WH_CBT, Some(quiet_activation), None, GetCurrentThreadId())' in source
    cleanup = source[source.index('impl Drop for QuietShowActivation'):source.index('/// No tao flag change')]
    assert 'quiet.set(self.previous)' in cleanup and 'UnhookWindowsHookEx(self.hook)' in cleanup
    assert 'QuietShowActivation' not in body(source, "start")


def test_escape_leaves_an_already_restored_os_placement_untouched():
    source = read("src-tauri/src/tearout/native.rs")
    restore = body(source, "restore_geometry")
    assert restore.index('if geometry(window)? == original { return Ok(()); }') < restore.index('SetWindowPlacement')
    assert 'escape_snapshot_equality_includes_show_state_and_normal_rectangle' in source
    definitions = read("src-tauri/src/tearout/mod.rs")
    assert '#[cfg_attr(target_os = "windows", derive(PartialEq, Eq))]' in definitions
