"""Pin native ownership and keep M4 changes inside Mac/platform safety gates."""
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]

def test_native_handle_ownership_is_pinned_to_the_leaking_runtime_version():
    lock=(ROOT/'src-tauri/Cargo.lock').read_text(encoding='utf-8')
    versions=re.findall(r'name = "tauri-runtime-wry"\nversion = "([^"]+)"',lock)
    assert versions==['2.10.1'], 'Review from_raw ownership before updating tauri-runtime-wry'
    source=(ROOT/'src-tauri/src/mac_webview.rs').read_text(encoding='utf-8')
    for method in ['inner','controller','ns_window']:
        assert source.count(f'Retained::<AnyObject>::from_raw(platform.{method}().cast())')==1
    assert source.count('view.with_webview(')==1
    assert 'PlatformWebview has no Drop' in source
    lib=(ROOT/'src-tauri/src/lib.rs').read_text(encoding='utf-8')
    assert '#[cfg(target_os = "macos")]\nmod mac_webview;' in lib
    for relative in ['src-tauri/src/e2e.rs','src-tauri/src/commands/webpane_native_mac.rs']:
        assert not re.search(r'\.with_webview\s*\(', (ROOT/relative).read_text(encoding='utf-8'))
    watchdog=(ROOT/'src-tauri/src/watchdog.rs').read_text(encoding='utf-8')
    mac=watchdog.split('#[cfg(target_os = "macos")]\npub(crate) fn register_process_failed',1)[1]
    assert 'crate::mac_webview::with_webview(webview,' in mac
    assert '.with_webview(' not in mac

def test_retry_identity_survives_reparenting_and_does_not_use_a_window_budget():
    source=(ROOT/'src-tauri/src/watchdog.rs').read_text(encoding='utf-8')
    mac=source.split('#[cfg(target_os = "macos")]\nfn recover_renderers(',1)[1].split('/// Tauri',1)[0]
    assert 'budgets.entry(failure.webview.clone())' in mac
    assert 'view.window()' not in mac
    assert 'app.get_webview(label).is_some()' in mac
    assert 'web_pane_failures_never_use_the_main_ui_budget_or_cooldown' in source
    assert 'reparenting_keeps_the_webview_failure_and_budget' in source

def test_trusted_input_restores_only_its_own_focus_and_has_a_hang_fallback():
    source=(ROOT/'src-tauri/src/commands/webpane_native_mac.rs').read_text(encoding='utf-8')
    assert 'struct FocusRestore' in source
    assert 'firstResponder' in source and 'isDescendantOf: &*saved.view' in source
    assert 'makeFirstResponder: saved.previous.as_deref()' in source
    assert 'scheduledTimerWithTimeInterval: 0.25f64' in source
    assert 'trusted input fence' in source
    dispatch=source.split('unsafe fn dispatch(',1)[1].split('struct FocusRestore',1)[0]
    assert 'makeFirstResponder' not in dispatch
    assert 'NSRange::new(usize::MAX' not in source
    assert 'NSRange::new(NSNotFound as usize' in source
    assert 'systemUptime' in source

def test_png_encoding_is_off_main_and_only_immutable_cgimage_crosses_threads():
    source=(ROOT/'src-tauri/src/commands/webpane_native_mac.rs').read_text(encoding='utf-8')
    screenshot=source.split('pub(super) async fn screenshot(',1)[1].split('fn finite(',1)[0]
    main,worker=screenshot.split('tokio::task::spawn_blocking',1)
    assert 'CGImageForProposedRect' in main
    assert 'CGImageRetain(cg)' in main
    assert 'TIFFRepresentation' not in main and 'representationUsingType_properties' not in main
    assert 'encode_snapshot(image)' in worker
    assert 'impl Drop for SnapshotImage' in source and 'CGImageRelease' in source

def test_late_upload_has_a_cancelling_delegate_and_cannot_borrow_the_next_upload():
    source=(ROOT/'src-tauri/src/commands/webpane_native_mac.rs').read_text(encoding='utf-8')
    assert 'allowsMultipleSelection' in source and 'allowsDirectories' in source
    assert 'validate_selection(self.ivars().urls.count(), multiple, directories)' in source
    assert 'scheduledTimerWithTimeInterval: 2.0f64' in source
    assert 'cancelled.set(true)' in source
    assert 'native file input is waiting for a cancelled request' in source

def test_robust_and_web_harnesses_use_their_worktree_seat():
    for name in ['build_mac_robust.py','mac_robust.py','run_mac_robust.py','build_mac_webpane.py','mac_webpane.py']:
        source=(ROOT/'scripts/e2e'/name).read_text(encoding='utf-8')
        assert "re.fullmatch(r'mycmux-wt-mac-([a-z0-9]+)-261003', ROOT.name)" in source,name
        assert 'mycmux-wt-mac-m2-261003' not in source and 'mycmux-wt-mac-m3-261003' not in source
        assert 'SEAT = match.group(1)' in source
    for name in ['build_mac_robust.py','build_mac_webpane.py']:
        source=(ROOT/'scripts/e2e'/name).read_text(encoding='utf-8')
        assert 'com.miyazaki.mycmux.e2e.{SEAT}' in source
        assert 'mycmux-{SEAT}-' in source
