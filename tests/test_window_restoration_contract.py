"""Restoring saved child windows (I-4, W9) must stay quiet and keep live child defaults.

Written by the I-4 seat inside tests/test_mac_renderer_recovery_contract.py, which at its base
still compared files with the v0.82.0 commit. That comparison was replaced by durable checks on
the integration branch, so this window-restoration contract moved here unchanged.
"""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def body(source,name):
    start=source.index('{',source.index('fn '+name+'('))
    depth=0
    for i in range(start,len(source)):
        depth+=(source[i]=='{')-(source[i]=='}')
        if depth==0:return source[start:i+1]
    raise AssertionError('unbalanced function '+name)


def test_i4_restoration_is_quiet_and_preserves_live_child_defaults():
    source=(ROOT/'src-tauri/src/commands/window.rs').read_text(encoding='utf-8')
    quiet=body(source,'reserve_child_window_label')
    assert '.resolve(|| all_window_labels(app), label)' in quiet
    assert '.set_focus(' not in quiet and '.show(' not in quiet
    restore=body(source,'restore_child_window_frame')
    assert 'app.get_window(label)' in restore and 'get_webview_window' not in restore
    assert restore.index('.set_size(')<restore.index('clamp_saved_window_origin(')<restore.index('.set_position(')
    assert '.set_focus(' not in restore
    constructor=body(source,'spawn_child_window')
    assert '.decorations(cfg!(target_os = "macos"))' in constructor
    assert '.min_inner_size(CHILD_WINDOW_MIN_WIDTH, CHILD_WINDOW_MIN_HEIGHT)' in constructor
    assert 'if let Some(decorated) = restored_decoration' in constructor
    assert 'builder = builder.decorations(decorated);' in constructor
    assert '#[cfg(target_os = "windows")]\n                { builder = builder.focused(restored_native); }' in constructor
    assert '#[cfg(not(target_os = "windows"))]\n                { builder = builder.focused(false); }' in constructor
    assert 'prepare_restored_window' in constructor
    assert 'restore_native_frame' in restore
    assert 'set_focusable' not in constructor and 'set_focusable' not in restore
    assert 'if restored_native { builder = builder.min_inner_size(240.0, 160.0); }' in constructor
    assert 'builder.initialization_script(if !restored_native {' in constructor
    assert 'window.__MYCMUX_RESTORED_WINDOW__ = true;' in constructor
    wrapper=body(source,'spawn_child_window_with_restore')
    assert wrapper.index('reservation.restored_decoration = restored_decoration;')<wrapper.index('spawn_child_window(')
