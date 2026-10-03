"""The Mac implementation must retain the native command's safety boundary."""
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
MAC=ROOT/'src-tauri/src/commands/webpane_native_mac.rs'
NATIVE=ROOT/'src-tauri/src/commands/webpane_native.rs'

def test_mac_commands_share_the_existing_budget_and_primary_webview_guard():
    source=NATIVE.read_text(encoding='utf-8')
    for command,operation in [('webpane_screenshot','screenshot'),('webpane_input_trusted','input_trusted'),('webpane_set_file_input','set_file_input')]:
        body=source.split('pub async fn '+command+'(',1)[1].split('\n#[',1)[0]
        assert body.index('caller.label() != caller.window().label()') < body.index('mac::'+operation)
        assert re.search(r'budget\s*\.run\(mac::'+operation,body)
        assert '#[cfg(target_os = "macos")]' in body
        assert '#[cfg(not(any(windows, target_os = "macos")))]' in body

def test_mac_never_posts_input_to_the_os_or_requests_accessibility():
    source=MAC.read_text(encoding='utf-8')
    for forbidden in ['CGEventPost','CGEventTapCreate','AXIsProcessTrusted','cliclick','NSOpenPanel','runModal','dispatchEvent(']:
        assert forbidden not in source
    assert 'wk.mouseDown(&event)' in source and 'wk.keyDown(&event)' in source
    assert 'takeSnapshotWithConfiguration_completionHandler' in source
    assert 'insertText:' in source

def test_upload_is_scoped_cancelled_and_restores_the_original_delegate():
    source=MAC.read_text(encoding='utf-8')
    upload=source.split('pub(super) async fn set_file_input(',1)[1]
    assert upload.index('check_generation(') < upload.index('spawn_blocking')
    assert 'impl Drop for UploadGuard' in source
    assert 'active.delegate.ivars().original.as_deref()' in source
    assert re.search(r'current\s*==\s*Retained::as_ptr\(&active.delegate\)\.cast\(\)',source)
    assert 'webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:' in source
    assert 'self.ivars().budget.call_timeout()' in source
    assert 'tx.is_closed()' in source

def test_mac_keeps_the_native_wire_messages_and_upload_limit():
    source=MAC.read_text(encoding='utf-8')
    for message in ['page changed since the target was resolved; snapshot again',
        'native file input paths must be absolute','web.upload files exceed the 25 MB limit',
        'trusted click button must be left, right, or middle','trusted clickCount must be between 1 and 3',
        'trusted input coordinates and deltas must be finite','selector matched no element']:
        assert message in source
    assert '25 * 1024 * 1024' in source
