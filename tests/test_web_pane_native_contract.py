import re
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "src-tauri/src/commands/webpane_native.rs"
WINDOWS = ROOT / "src-tauri/src/commands/webpane_native_win.rs"
COMMANDS = ("webpane_screenshot", "webpane_input_trusted", "webpane_set_file_input")


def command_source(command: str) -> tuple[str, str]:
    source = NATIVE.read_text(encoding="utf-8")
    match = re.search(
        rf"pub async fn {command}\((.*?)\) -> Result<[^\n]+> \{{(.*?)(?=\n#\[)",
        source,
        re.S,
    )
    assert match, command
    return match.group(1), match.group(2)


@pytest.mark.parametrize("command", COMMANDS)
def test_native_command_rejects_child_webviews_before_platform_or_native_work(command: str) -> None:
    signature, body = command_source(command)
    assert "caller: tauri::Webview" in signature
    guard = "if caller.label() != caller.window().label() {"
    assert body.lstrip().startswith(guard)
    assert re.search(
        rf'if caller\.label\(\) != caller\.window\(\)\.label\(\) \{{\s*return Err\(\s*"{command} is only available to the primary app webview"\.to_string\(\),?\s*\);\s*\}}',
        body,
    )
    assert body.index(guard) < body.index("#[cfg(windows)]") < body.index("super::webpane_native_win::")


def test_native_sources_do_not_open_debugging_ports_or_use_cookie_apis() -> None:
    source = NATIVE.read_text(encoding="utf-8") + WINDOWS.read_text(encoding="utf-8")
    for forbidden in (
        "remote-debugging", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "set_cookie", "cookies_for_url", "cookie_manager", "ICoreWebView2CookieManager",
        "Network.getCookies", "Network.getAllCookies", "Storage.getCookies",
        "Network.setCookie", "Network.deleteCookies", "Network.clearBrowserCookies",
    ):
        assert forbidden not in source, forbidden


@pytest.mark.parametrize("command", COMMANDS)
def test_every_native_command_awaits_the_shared_deadline(command: str) -> None:
    _, body = command_source(command)
    assert "NativeBudget::new(" in body
    assert re.search(r"budget\s*\.run\(super::webpane_native_win::", body)
    assert "&budget" in body and ".await" in body


@pytest.mark.parametrize("command", COMMANDS)
def test_native_commands_forward_the_optional_socket_budget_and_command_name(command: str) -> None:
    signature, body = command_source(command)
    assert "budget_ms: Option<u64>" in signature
    assert "command: Option<String>" in signature
    default = {
        "webpane_screenshot": '"web.screenshot"',
        "webpane_input_trusted": "action.command_name()",
        "webpane_set_file_input": '"web.upload"',
    }[command]
    assert re.search(
        rf"NativeBudget::new\(\s*{re.escape(default)}\s*,\s*budget_ms\s*,\s*command\s*\)",
        body,
    )


def test_generation_guard_precedes_native_input_and_upload_work() -> None:
    source = WINDOWS.read_text(encoding="utf-8")
    trusted = source.split("pub(super) async fn input_trusted(", 1)[1].split("fn input_files(", 1)[0]
    upload = source.split("pub(super) async fn set_file_input(", 1)[1].split("#[cfg(test)]", 1)[0]
    for body, next_work in [(trusted, "let (kind, events)"), (upload, "tokio::task::spawn_blocking")]:
        assert body.index("check_generation(") < body.index(next_work)
        assert '"Runtime.evaluate"' in body[:body.index(next_work)]
    signature, _ = command_source("webpane_set_file_input")
    assert "expected_generation: Option<u64>" in signature


@pytest.mark.parametrize("dispatch", ("super::webpane_native_win::input_trusted(", "mac::input_trusted("))
def test_operator_focus_marks_validated_tab_before_native_dispatch(dispatch: str) -> None:
    _, body = command_source("webpane_input_trusted")
    assert (
        body.index("caller.label() != caller.window().label()")
        < body.index("webview_label(&tab_id)?")
        < body.index("mark_automation_input(&label)")
        < body.index("app.get_webview(&label)")
        < body.index(dispatch)
    )


def test_operator_focus_uses_canonical_label_and_process_lifetime_marks() -> None:
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    gate = NATIVE.with_name("webpane_operator_focus.rs").read_text(encoding="utf-8")
    create = webpane.split("pub async fn webpane_create(", 1)[1].split("#[tauri::command]", 1)[0]
    assert "let label = webview_label(&tab_id)?;" in create
    assert "let operator_focus_label = label.clone();" in create
    assert "operator_focus_decision(" in create
    assert "preset.id, &operator_focus_label," in create
    assert "input_activity::blocks(" not in create
    touches = gate.split("struct AutomationTouches", 1)[1].split("enum OperatorFocusDecision", 1)[0]
    assert ".remove(" not in touches and ".clear(" not in touches
    # Marking is limited to authenticated mutation entry points. Reuse, reload, and
    # destruction cannot remove a mark from the process-lifetime table.
    assert re.findall(r"automation_touches\(\)\.(\w+)\(", webpane) == ["mark", "record_command"]
    assert "mark_automation_input(" not in create and ".record_command(" not in create


@pytest.mark.parametrize(("command", "source", "origin", "next_step"), (
    ("eval", "webpane", "automation", "validate_eval_script("),
    ("navigate", "webpane", "automation", "match (url, action.as_deref())"),
    ("click", "webpane", "None", "helper_result("),
    ("type", "webpane", "None", "let mode ="),
    ("key", "webpane", "None", "helper_result("),
    ("scroll", "webpane", "None", "helper_result("),
    ("upload", "webpane", "None", "let mode ="),
    ("push", "webpane", "None", "composer_preset("),
))
def test_operator_focus_records_mutating_commands_before_page_work(command, source, origin, next_step) -> None:
    rust = NATIVE.with_name(f"{source}.rs").read_text(encoding="utf-8")
    name = f"webpane_{command}"
    body = rust.split(f"pub async fn {name}(", 1)[1].split("\n#[tauri::command]", 1)[0]
    call = re.search(rf'command_webview\(&caller, &app, &tab_id, "[^"]+", {origin}\)\?', body)
    assert call, name
    assert call.start() < body.index(next_step)


def test_operator_focus_defaults_to_marking_before_resolving_the_webview() -> None:
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    lookup = webpane.split("fn command_webview(", 1)[1].split("fn composer_preset(", 1)[0]
    assert (
        lookup.index("caller.label() != caller.window().label()")
        < lookup.index("webview_label(tab_id)?")
        < lookup.index("record_command(&label, automation)")
        < lookup.index(".get_webview(&label)")
    )


def test_operator_focus_navigation_marks_before_running_any_navigation_branch() -> None:
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    navigate = webpane.split("pub async fn webpane_navigate(", 1)[1].split("\n#[tauri::command]", 1)[0]
    lookup = navigate.index('command_webview(&caller, &app, &tab_id, "web.navigate", automation)?')
    assert navigate.index('Some("preview-link")') < lookup
    for action in (".navigate(parsed)", ".reload()", '.eval("history.back()")', '.eval("history.forward()")'):
        assert lookup < navigate.index(action)


def test_operator_focus_marks_trusted_upload_before_platform_dispatch() -> None:
    _, body = command_source("webpane_set_file_input")
    assert (
        body.index("caller.label() != caller.window().label()")
        < body.index("webview_label(&tab_id)?")
        < body.index("mark_automation_input(&label)")
        < body.index("super::webpane_native_win::set_file_input(")
        < body.index("mac::set_file_input(")
    )


@pytest.mark.parametrize("command", ("read", "snapshot", "find", "downloads", "dialogs", "reload_preview"))
def test_operator_focus_read_and_human_preview_commands_do_not_mark(command) -> None:
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    body = webpane.split(f"pub async fn webpane_{command}(", 1)[1].split("\n#[tauri::command]", 1)[0]
    assert re.search(r'command_webview\(&caller, &app, &tab_id, "[^"]+", Some\(false\)\)\?', body)
    assert "mark_automation_input(" not in body


def test_trusted_input_starts_tracking_and_checks_registered_key_before_native_work() -> None:
    _, body = command_source("webpane_input_trusted")
    assert body.index("mark_automation_input(&label)") < body.index("InputAttempt::begin(")
    for dispatch in ("super::webpane_native_win::input_trusted(", "mac::input_trusted("):
        assert body.index("InputAttempt::begin(") < body.index("reject_registered_native_key(") < body.index(dispatch)
    assert body.count("app.get_webview(&label)") == 1


def test_windows_trusted_input_reuses_its_webview_and_tracks_before_delivery() -> None:
    source = WINDOWS.read_text(encoding="utf-8")
    trusted = source.split("pub(super) async fn input_trusted(", 1)[1].split("fn input_files(", 1)[0]
    assert "view: tauri::Webview" in trusted
    assert "get_webview(" not in trusted and "cdp_call(" not in trusted
    assert trusted.count("cdp_call_on(&view,") == 3
    cdp = source.split("async fn cdp_call_on(", 1)[1].split("fn viewport_from_reply(", 1)[0]
    assert "get_webview(" not in cdp
    assert cdp.index("receipt.begin_pending()") < cdp.index("core.CallDevToolsProtocolMethod(")
    assert cdp.index("receipt.complete(") < cdp.index("completed_sender.borrow_mut().take()")
    assert "receipt.cancel_pending()" in cdp


def test_mac_trusted_input_reuses_its_webview_and_tracks_before_delivery() -> None:
    source = NATIVE.with_name("webpane_native_mac.rs").read_text(encoding="utf-8")
    trusted = source.split("pub(super) async fn input_trusted(", 1)[1].split("fn input_files(", 1)[0]
    assert "view: tauri::Webview" in trusted and "check_generation(&view," in trusted
    assert "webview(app," not in trusted
    assert trusted.index("receipt.begin_pending()") < trusted.index("dispatch(wk, &action)")
    completion = trusted.split("send_input_fences(wk, dispatched_events, Box::new(move |fence| {", 1)[1]
    assert completion.lstrip().startswith("receipt.complete(unix_millis());")
    assert completion.index("receipt.complete(") < completion.index("tx.send(result.and(fence))")


def test_forwarding_checks_input_activity_and_destruction_clears_it() -> None:
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    forward = webpane.split("pub async fn webpane_forward_shortcut(", 1)[1].split("fn shortcut_initialization_script(", 1)[0]
    assert "authorize_forwarded_shortcut(" in forward
    assert "&input_activity::activity_at(now)" in forward
    destroy = webpane.split("pub async fn webpane_destroy(", 1)[1].split("#[tauri::command]", 1)[0]
    assert "input_activity::forget_webview(&label)" in destroy
    assert "input_activity::forget_webview(label)" in webpane


def test_operator_focus_moves_primary_focus_only_after_validating_acknowledgement() -> None:
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    source = NATIVE.with_name("webpane_operator_focus.rs").read_text(encoding="utf-8")
    navigation = webpane.split("if url.host_str() == Some(operator_focus::REQUEST_HOST)", 1)[1].split('if preset.id == "preview"', 1)[0]
    assert "operator_focus::emit_request(" in navigation
    assert "set_focus(" not in navigation
    sender = source.split("pub(super) fn emit_request(", 1)[1].split("pub(super) fn listen_for_acceptance(", 1)[0]
    assert sender.index("pending_focus_requests().remember(") < sender.index("app.emit_to(")
    assert "pending_focus_requests().0.remove(&id)" in sender
    receiver = source.split("pub(super) fn listen_for_acceptance(", 1)[1]
    assert "app.listen_any(ACCEPTED_EVENT" in receiver
    assert receiver.index("pending_focus_requests().consume(") < receiver.index("primary.set_focus()")
    assert "label.and_then(|label| app_handle.get_webview(&label))" in receiver


def test_signin_preserves_the_existing_webview_shortcut_proof_gate() -> None:
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    signin = webpane.split("pub async fn webpane_signin(", 1)[1].split("#[tauri::command]", 1)[0]
    assert "shortcut_proofs().remove(" not in signin
    create = webpane.split("pub async fn webpane_create(", 1)[1].split("#[tauri::command]", 1)[0]
    reused, created = create.split("return Ok(label);", 1)
    assert "update_shortcut_registration(&webview" in reused
    assert "shortcut_proofs()." not in reused
    assert "input_activity::forget_webview(" not in reused
    assert "ShortcutProofGate::with_key(shortcut_key)" in created



def test_renderer_exit_ends_native_wait_before_scheduling_recovery() -> None:
    watchdog = (ROOT / "src-tauri/src/watchdog.rs").read_text(encoding="utf-8")
    windows = watchdog.split("#[cfg(windows)]\npub(crate) fn register_process_failed(", 1)[1]
    windows = windows.split('#[cfg(not(any(windows, target_os = "macos")))]', 1)[0]
    assert re.search(
        r"if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED\.0 \{\s*"
        r"crate::commands::webpane_native::native_input_renderer_failed\(&webview_label\);\s*"
        r"\}\s*queue_renderer_failure\(",
        windows,
    )
    mac = watchdog.split('fn terminated(delegate:', 1)[1].split("pub(super) unsafe fn register", 1)[0]
    assert mac.index("native_input_renderer_failed(label);") < mac.index("queue_renderer_failure(")
    native = NATIVE.read_text(encoding="utf-8")
    failure = native.split("fn native_input_renderer_failed(", 1)[1].split("\n}", 1)[0]
    assert "input_activity::forget_webview(label)" in failure
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    on_load = webpane.split(".on_page_load(", 1)[1].split("let webview =", 1)[0]
    assert "forget_webview(" not in on_load and "native_input_renderer_failed(" not in on_load


def test_prepare_rejects_missing_or_disabled_targets_before_scrolling() -> None:
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    prepare = webpane.split("const prepare = target => {", 1)[1].split("\n  };", 1)[0]
    disabled = 'if (el.disabled || el.getAttribute("aria-disabled") === "true") throw new Error("target is disabled");'
    assert prepare.index("const el = resolve(target);") < prepare.index(disabled) < prepare.index("el.scrollIntoView(")


def test_wait_uses_the_shared_internal_read_script() -> None:
    socket_commands = (ROOT / "src/components/layout/socketCommands.ts").read_text(encoding="utf-8")
    wait = socket_commands.split('case "web.wait": {', 1)[1].split('case "web.snapshot": {', 1)[0]
    assert "const script = api.buildWebPaneWaitScript(state, selector);" in wait


def test_forwarded_shortcut_does_not_return_denials_to_the_page() -> None:
    webpane = NATIVE.with_name("webpane.rs").read_text(encoding="utf-8")
    forward = webpane.split("pub async fn webpane_forward_shortcut(", 1)[1].split("fn shortcut_initialization_script(", 1)[0]
    assert "ipc.log_denied()" in forward
    assert forward.strip().endswith("Ok(())\n}")
    before, authorization = forward.split("    let result = (|| {", 1)
    _, after = authorization.split("\n    })();", 1)
    assert not re.search(r"\breturn\s+Err\b|\?\s*;", before + after)
    assert "payload: Option<serde_json::Value>" in forward
    assert re.search(
        r"let Ok\(payload\) = serde_json::from_value::<WebPaneForwardedKey>\(payload.unwrap_or_default\(\)\) else \{\s*"
        r"ipc.log_denied\(\);\s*return Ok\(\(\)\);\s*\};",
        forward,
    )


def test_window_focus_can_move_input_from_its_own_child_to_the_primary_view() -> None:
    window = NATIVE.with_name("window.rs").read_text(encoding="utf-8")
    focus = window.split("pub async fn focus_window(", 1)[1].split("\nconst ", 1)[0]
    assert "focus_primary: Option<bool>" in focus
    assert re.search(
        r"let primary = if focus_primary == Some\(true\) \{\s*"
        r"if !may_focus_primary\(caller\.label\(\), caller\.window\(\)\.label\(\), &label\) \{\s*"
        r'return Err\("The primary webview must request its own input focus"\.into\(\)\);\s*'
        r"\}\s*Some\(caller\)\s*\} else \{\s*None\s*\};",
        focus,
    )
    assert focus.index("restore_and_focus(&window)") < focus.index("primary.set_focus()")


def test_operator_focus_acceptance_receiver_is_installed_in_setup() -> None:
    lib = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    setup = lib.split(".setup(", 1)[1].split(".on_window_event(", 1)[0]
    assert "commands::webpane::listen_for_operator_focus_acceptance(&app_handle);" in setup


def test_operator_focus_window_listener_is_installed_when_app_is_ready() -> None:
    app = (ROOT / "src/App.tsx").read_text(encoding="utf-8")
    assert "useEffect(() => { if (ready) return connectOperatorFocusWindowNavigation(); }, [ready]);" in app


def test_destroyed_window_releases_only_its_native_input_waits() -> None:
    lib = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    handler = lib.split(".on_window_event(", 1)[1].split(".build(", 1)[0]
    assert re.search(
        r'if matches!\(event, tauri::WindowEvent::Destroyed\) \{\s*'
        r'#\[cfg\(target_os = "windows"\)\]\s*snap_layouts::window_destroyed\(window.label\(\)\);\s*'
        r'#\[cfg\(any\(windows, target_os = "macos"\)\)\]\s*'
        r'commands::webpane_native::native_input_window_destroyed\(window.label\(\)\);',
        handler,
    )


def test_windows_cdp_pending_guard_aborts_and_failed_start_cancels() -> None:
    source = WINDOWS.read_text(encoding="utf-8")
    cdp = source.split("async fn cdp_call_on(", 1)[1].split("fn viewport_from_reply(", 1)[0]
    assert re.search(r"if receipt\.as_ref\(\)\.is_some_and\(\|receipt\| !receipt\.begin_pending\(\)\)"
                     r"\s*\{\s*return;\s*\}\s*let started =", cdp)
    failed_start = re.search(r"if let Err\(error\) = started \{(.*?)\n            \}", cdp, re.S)
    assert failed_start and "receipt.cancel_pending()" in failed_start.group(1)
    assert cdp.count("receipt.cancel_pending()") == 1


def test_pending_reply_underflow_is_guarded_on_all_native_input_platforms() -> None:
    activity = NATIVE.with_name("webpane_input_activity.rs").read_text(encoding="utf-8")
    assert re.search(r'debug_assert!\(.*pending.*\);', activity)
    assert ".saturating_sub(1)" in activity


def test_input_intervals_allow_unused_native_state_on_other_platforms() -> None:
    activity = NATIVE.with_name("webpane_input_activity.rs").read_text(encoding="utf-8")
    assert re.search(
        r'#\[cfg_attr\(not\(any\(windows, target_os = "macos", test\)\), allow\(dead_code\)\)\]\s*'
        r'struct InputInterval \{',
        activity,
    )


def test_primary_pane_layout_keeps_notices_outside_the_native_child_bounds() -> None:
    for layout in ("workspace/TerminalPane.tsx", "layout/DetachedPaneShell.tsx"):
        source = (ROOT / "src/components" / layout).read_text(encoding="utf-8")
        assert re.search(r'<WebPaneStatusBar\b[^>]+/>\s*<div\s+data-web-pane-host-tab-id=', source)
    status = (ROOT / "src/components/workspace/WebPaneStatusBar.tsx").read_text(encoding="utf-8")
    assert "data-web-pane-notice=" in status and "flexShrink: 0" in status
