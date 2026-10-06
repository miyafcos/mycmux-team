from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(relative):
    return (ROOT / relative).read_text(encoding="utf-8")


def test_preview_popups_never_reach_the_os_opener():
    rust = read("src-tauri/src/commands/webpane.rs")
    popup = rust[rust.index(".on_new_window(move") : rust.index("let creation_start", rust.index(".on_new_window(move"))]
    preview = popup[popup.index('if preset.id == "preview"') : popup.index('if preset.id == "browser"')]
    assert "NewWindowResponse::Deny" in preview
    assert "open_in_os_browser" not in preview
    assert "preview_links::open" not in preview
    assert "open_in_os_browser(&new_window_app, url.as_str())" in popup
    assert "gate.consume(url, std::time::Instant::now())" in rust


def test_every_frame_kind_and_editor_installs_the_same_trusted_click_handler():
    browser = read("src/components/workspace/BrowserPane.tsx")
    handler = browser[browser.index("const handleFrameLoad") : browser.index("const getEditorDocument", browser.index("const handleFrameLoad"))] if "const getEditorDocument" in browser else browser[browser.index("const handleFrameLoad") :]
    assert handler.index("installPreviewLinkHandler(doc") < handler.index("if (!isEditing)")
    assert "detachPreviewLinks();" in handler
    assert "detachPreviewLinks," in handler
    assert "allow-scripts" not in browser
    assert 'type="application/pdf"' in browser
    assert "@tauri-apps/plugin-shell" not in browser
    frame = read("src/lib/previewLinks.ts")
    assert "if (!event.isTrusted) return" in frame
    assert "event.stopImmediatePropagation()" in frame


def test_preview_recording_is_profile_only_and_fail_closed():
    rust = read("src-tauri/src/commands/webpane.rs")
    recorder = rust[rust.index("fn preview_link_recording_enabled") : rust.index("fn open_in_os_browser")]
    assert 'profile_active && value == Some("1")' in recorder
    assert "crate::test_profile::is_active()" in recorder
    assert "crate::test_profile::runtime_dir()?" in recorder
    native = read("src-tauri/src/commands/webpane_preview_links.rs")
    assert 'super::record_preview_link(kind, &canonical.to_string_lossy())?' in native
    assert 'super::record_preview_link("browser", url.as_str())?' in native
    assert "open_path_with_default_app" not in native


def test_frames_cannot_invoke_the_native_link_route_as_child_webviews():
    rust = read("src-tauri/src/commands/webpane.rs")
    command = rust[rust.index("pub async fn webpane_navigate(") : rust.index("pub async fn webpane_reload_preview(")]
    preview = command[command.index('if action.as_deref() == Some("preview-link")') : command.index("let webview = command_webview")]
    assert "caller.label() != caller.window().label()" in preview
    assert "preview_links::throttle_primary(caller.label())?" in preview
    assert "preview_links::open(app, target).await?" in preview
