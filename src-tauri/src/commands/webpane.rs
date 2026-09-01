use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl, Window,
};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPanePreset {
    pub id: &'static str,
    pub label: &'static str,
    pub url: &'static str,
    pub profile_dir: &'static str,
}

const WEB_PANE_PRESETS: &[WebPanePreset] = &[WebPanePreset {
    id: "chatgpt",
    label: "ChatGPT",
    url: "https://chatgpt.com/",
    profile_dir: "chatgpt",
}];

const WEB_PANE_KEYDOWN_EVENT: &str = "mycmux:web-pane-keydown";
const WEB_PANE_SHORTCUT_STATE: &str = "__MYCMUX_WEB_PANE_SHORTCUT_STATE__";
const WEB_PANE_PUSH_TIMEOUT: Duration = Duration::from_secs(5);
const WEB_PANE_MAX_TEXT_BYTES: usize = 256 * 1024;
const CHATGPT_COMPOSER_HOST: &str = "chatgpt.com";
static WEB_PANE_PUSH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static WEB_PANE_PUSH_RESULTS: OnceLock<
    DashMap<
        String,
        (
            String,
            tokio::sync::oneshot::Sender<WebPanePushEventPayload>,
        ),
    >,
> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebPanePushEventPayload {
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPanePushResult {
    tab_id: String,
    submitted: bool,
    text_bytes: usize,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPaneBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl WebPaneBounds {
    fn validate(self) -> Result<Self, String> {
        if !self.x.is_finite()
            || !self.y.is_finite()
            || !self.width.is_finite()
            || !self.height.is_finite()
        {
            return Err("web pane bounds must be finite".to_string());
        }
        if self.width <= 0.0 || self.height <= 0.0 {
            return Err("web pane width and height must be positive".to_string());
        }
        Ok(self)
    }
}

fn preset_by_id(id: &str) -> Result<WebPanePreset, String> {
    WEB_PANE_PRESETS
        .iter()
        .copied()
        .find(|preset| preset.id == id)
        .ok_or_else(|| format!("unknown web pane preset: {id}"))
}

fn safe_directory_component(value: &str) -> Result<&str, String> {
    let path = Path::new(value);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(component)), None) if !component.is_empty() => Ok(value),
        _ => Err(format!("invalid web pane profile directory: {value}")),
    }
}

fn profile_directory(base: PathBuf, preset: WebPanePreset) -> Result<PathBuf, String> {
    Ok(base
        .join("web-profiles")
        .join(safe_directory_component(preset.profile_dir)?))
}

fn webview_label(tab_id: &str) -> Result<String, String> {
    if tab_id.is_empty()
        || tab_id.len() > 128
        || !tab_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("web pane tab id contains unsupported characters".to_string());
    }
    Ok(format!("web-pane-{tab_id}"))
}

fn validate_forwarded_shortcuts(mut shortcuts: Vec<String>) -> Result<Vec<String>, String> {
    if shortcuts.len() > 32 {
        return Err("too many forwarded web pane shortcuts".to_string());
    }
    for shortcut in &shortcuts {
        if shortcut.is_empty()
            || shortcut.len() > 64
            || !shortcut.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'+' || byte == b'-'
            })
        {
            return Err(format!("invalid forwarded web pane shortcut: {shortcut}"));
        }
    }
    shortcuts.sort();
    shortcuts.dedup();
    Ok(shortcuts)
}

fn shortcut_initialization_script(tab_id: &str, shortcuts: &[String]) -> Result<String, String> {
    let tab_id = serde_json::to_string(tab_id)
        .map_err(|error| format!("failed to serialize web pane tab id: {error}"))?;
    let shortcuts = serde_json::to_string(shortcuts)
        .map_err(|error| format!("failed to serialize web pane shortcuts: {error}"))?;
    let state_name = serde_json::to_string(WEB_PANE_SHORTCUT_STATE)
        .map_err(|error| format!("failed to serialize web pane shortcut state: {error}"))?;
    let event_name = serde_json::to_string(WEB_PANE_KEYDOWN_EVENT)
        .map_err(|error| format!("failed to serialize web pane shortcut event: {error}"))?;
    Ok(format!(
        r#"(() => {{
  const stateName = {state_name};
  const state = {{ shortcuts: new Set({shortcuts}) }};
  Object.defineProperty(window, stateName, {{ value: state, configurable: false, enumerable: false }});
  document.addEventListener("keydown", (event) => {{
    if (!event.isTrusted || event.defaultPrevented || event.isComposing || event.key === "Process" || event.keyCode === 229) return;
    const parts = [];
    if (event.ctrlKey) parts.push("ctrl");
    if (event.altKey) parts.push("alt");
    if (event.shiftKey) parts.push("shift");
    if (event.metaKey) parts.push("meta");
    let key = event.key.toLowerCase();
    if (key === " ") key = "space";
    if (key === "esc") key = "escape";
    if (["control", "alt", "shift", "meta"].includes(key)) return;
    parts.push(key);
    if (!state.shortcuts.has(parts.join("+"))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {{
      event: {event_name},
      payload: {{
        tabId: {tab_id},
        key: event.key,
        code: event.code,
        location: event.location,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        isComposing: event.isComposing
      }}
    }}).catch(() => undefined);
  }}, true);
}})();"#,
    ))
}

fn shortcut_update_script(shortcuts: &[String]) -> Result<String, String> {
    let shortcuts = serde_json::to_string(shortcuts)
        .map_err(|error| format!("failed to serialize web pane shortcuts: {error}"))?;
    let state_name = serde_json::to_string(WEB_PANE_SHORTCUT_STATE)
        .map_err(|error| format!("failed to serialize web pane shortcut state: {error}"))?;
    Ok(format!(
        r#"(() => {{
  const state = window[{state_name}];
  if (state) state.shortcuts = new Set({shortcuts});
}})();"#,
    ))
}

fn composer_push_script(
    request_id: &str,
    text: Option<&str>,
    submit: bool,
) -> Result<String, String> {
    if text.is_none() && !submit {
        return Err("web pane push requires text or submit=true".to_string());
    }
    if let Some(text) = text {
        if text.len() > WEB_PANE_MAX_TEXT_BYTES {
            return Err(format!(
                "web pane text exceeds the {WEB_PANE_MAX_TEXT_BYTES}-byte limit"
            ));
        }
    }

    let request_id = serde_json::to_string(request_id)
        .map_err(|error| format!("failed to serialize web pane push request: {error}"))?;
    let insert_script = match text {
        Some(text) => {
            let text = serde_json::to_string(text)
                .map_err(|error| format!("failed to serialize web pane text: {error}"))?;
            format!(
                r#"const text = {text};
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {{
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error("ChatGPT composer value setter is unavailable");
      setter.call(composer, text);
    }} else {{
      composer.textContent = text;
    }}
    composer.dispatchEvent(new InputEvent("input", {{
      bubbles: true,
      inputType: "insertText",
      data: text
    }}));"#,
            )
        }
        None => "composer.focus();".to_string(),
    };
    let submit_script = if submit {
        r#"window.setTimeout(() => {
      try {
        const submitButton = document.querySelector('[data-testid="send-button"]')
          ?? composer.closest("form")?.querySelector('button[type="submit"]');
        if (!(submitButton instanceof HTMLButtonElement)) {
          throw new Error("ChatGPT submit button was not found");
        }
        if (submitButton.disabled) throw new Error("ChatGPT submit button is disabled");
        submitButton.click();
        finish({ ok: true });
      } catch (error) {
        fail(error);
      }
    }, 0);"#
    } else {
        "finish({ ok: true });"
    };

    Ok(format!(
        r##"(() => {{
  const requestId = {request_id};
  const finish = (payload) => {{
    void window.__TAURI_INTERNALS__.invoke("webpane_push_result", {{
      requestId,
      ok: payload.ok,
      error: payload.error ?? null
    }})
      .catch(() => undefined);
  }};
  const fail = (error) => finish({{
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }});
  try {{
    const composer = document.querySelector("#prompt-textarea");
    if (!(composer instanceof HTMLElement)) {{
      throw new Error("ChatGPT composer #prompt-textarea was not found");
    }}
    {insert_script}
    {submit_script}
  }} catch (error) {{
    fail(error);
  }}
}})();"##,
    ))
}

fn set_webview_bounds(webview: &tauri::Webview, bounds: WebPaneBounds) -> Result<(), String> {
    let bounds = bounds.validate()?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("failed to position web pane: {error}"))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| format!("failed to size web pane: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn webpane_list_presets() -> Vec<WebPanePreset> {
    WEB_PANE_PRESETS.to_vec()
}

#[tauri::command]
pub async fn webpane_create(
    window: Window,
    app: AppHandle,
    tab_id: String,
    preset_id: String,
    bounds: WebPaneBounds,
    forwarded_shortcuts: Vec<String>,
) -> Result<String, String> {
    let label = webview_label(&tab_id)?;
    let bounds = bounds.validate()?;
    let forwarded_shortcuts = validate_forwarded_shortcuts(forwarded_shortcuts)?;

    if let Some(webview) = app.get_webview(&label) {
        if webview.window().label() != window.label() {
            return Err(format!(
                "web pane {tab_id} is attached to a different window"
            ));
        }
        webview
            .eval(shortcut_update_script(&forwarded_shortcuts)?)
            .map_err(|error| format!("failed to update web pane shortcuts: {error}"))?;
        set_webview_bounds(&webview, bounds)?;
        webview
            .show()
            .map_err(|error| format!("failed to show web pane: {error}"))?;
        return Ok(label);
    }

    let preset = preset_by_id(&preset_id)?;
    let local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve local app data directory: {error}"))?;
    let profile_dir = profile_directory(
        crate::test_profile::app_data_dir_from(local_data_dir),
        preset,
    )?;
    std::fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("failed to create web pane profile directory: {error}"))?;
    let profile_dir = profile_dir
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize web pane profile directory: {error}"))?;
    let url = preset
        .url
        .parse()
        .map_err(|error| format!("invalid web pane preset URL: {error}"))?;

    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
        .focused(false)
        .data_directory(profile_dir)
        .initialization_script(shortcut_initialization_script(
            &tab_id,
            &forwarded_shortcuts,
        )?);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| format!("failed to create web pane: {error}"))?;
    webview
        .show()
        .map_err(|error| format!("failed to show web pane: {error}"))?;
    Ok(label)
}

#[tauri::command]
pub async fn webpane_update(
    app: AppHandle,
    tab_id: String,
    bounds: Option<WebPaneBounds>,
    visible: bool,
    forwarded_shortcuts: Vec<String>,
) -> Result<(), String> {
    let label = webview_label(&tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("web pane does not exist: {tab_id}"))?;
    let forwarded_shortcuts = validate_forwarded_shortcuts(forwarded_shortcuts)?;
    webview
        .eval(shortcut_update_script(&forwarded_shortcuts)?)
        .map_err(|error| format!("failed to update web pane shortcuts: {error}"))?;

    if !visible {
        return webview
            .hide()
            .map_err(|error| format!("failed to hide web pane: {error}"));
    }

    let bounds = bounds.ok_or_else(|| "visible web pane requires bounds".to_string())?;
    set_webview_bounds(&webview, bounds)?;
    webview
        .show()
        .map_err(|error| format!("failed to show web pane: {error}"))
}

#[tauri::command]
pub async fn webpane_destroy(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = webview_label(&tab_id)?;
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|error| format!("failed to destroy web pane: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn webpane_push(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    text: Option<String>,
    submit: bool,
) -> Result<WebPanePushResult, String> {
    if caller.label() != caller.window().label() {
        return Err("webpane_push is only available to the primary app webview".to_string());
    }
    let _push_guard = WEB_PANE_PUSH_LOCK.lock().await;
    let label = webview_label(&tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("web pane does not exist: {tab_id}"))?;
    let current_url = webview
        .url()
        .map_err(|error| format!("failed to read web pane URL: {error}"))?;
    let host = current_url.host_str().unwrap_or_default();
    if host != CHATGPT_COMPOSER_HOST && !host.ends_with(&format!(".{CHATGPT_COMPOSER_HOST}")) {
        return Err(format!(
            "web pane is not on an allowed ChatGPT composer host: {host}"
        ));
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let script = composer_push_script(&request_id, text.as_deref(), submit)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    WEB_PANE_PUSH_RESULTS
        .get_or_init(DashMap::new)
        .insert(request_id.clone(), (label.clone(), sender));

    if let Err(error) = webview.eval(script) {
        WEB_PANE_PUSH_RESULTS
            .get_or_init(DashMap::new)
            .remove(&request_id);
        return Err(format!("failed to evaluate web pane push script: {error}"));
    }

    let payload = match tokio::time::timeout(WEB_PANE_PUSH_TIMEOUT, receiver).await {
        Ok(Ok(payload)) => payload,
        Ok(Err(_)) => {
            WEB_PANE_PUSH_RESULTS
                .get_or_init(DashMap::new)
                .remove(&request_id);
            return Err("web pane push result channel closed".to_string());
        }
        Err(_) => {
            WEB_PANE_PUSH_RESULTS
                .get_or_init(DashMap::new)
                .remove(&request_id);
            return Err("web pane push timed out waiting for the composer".to_string());
        }
    };
    if !payload.ok {
        return Err(payload
            .error
            .unwrap_or_else(|| "web pane push failed".to_string()));
    }

    Ok(WebPanePushResult {
        tab_id,
        submitted: submit,
        text_bytes: text.as_ref().map_or(0, |value| value.len()),
    })
}

#[tauri::command]
pub async fn webpane_push_result(
    caller: Webview,
    request_id: String,
    ok: bool,
    error: Option<String>,
) -> Result<(), String> {
    let pending = WEB_PANE_PUSH_RESULTS.get_or_init(DashMap::new);
    let expected_label = pending
        .get(&request_id)
        .map(|entry| entry.value().0.clone())
        .ok_or_else(|| "unknown web pane push request".to_string())?;
    if caller.label() != expected_label {
        return Err("web pane push result came from the wrong webview".to_string());
    }
    let (_, (_, sender)) = pending
        .remove(&request_id)
        .ok_or_else(|| "web pane push request already completed".to_string())?;
    sender
        .send(WebPanePushEventPayload { ok, error })
        .map_err(|_| "web pane push request receiver closed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_registry_is_generic_and_resolves_chatgpt() {
        assert_eq!(WEB_PANE_PRESETS.len(), 1);
        let preset = preset_by_id("chatgpt").unwrap();
        assert_eq!(preset.label, "ChatGPT");
        assert_eq!(preset.url, "https://chatgpt.com/");
        assert_eq!(preset.profile_dir, "chatgpt");
        assert!(preset_by_id("missing").is_err());
    }

    #[test]
    fn profile_directory_stays_below_web_profiles() {
        let preset = preset_by_id("chatgpt").unwrap();
        let base = PathBuf::from(r"C:\Users\test\AppData\Local\com.miyazaki.mycmux");
        assert_eq!(
            profile_directory(base.clone(), preset).unwrap(),
            base.join("web-profiles").join("chatgpt")
        );
        let invalid = WebPanePreset {
            profile_dir: "../escape",
            ..preset
        };
        assert!(profile_directory(base, invalid).is_err());
    }

    #[test]
    fn webview_labels_accept_persisted_ids_only() {
        assert_eq!(webview_label("tab_1-abc").unwrap(), "web-pane-tab_1-abc");
        for invalid in ["", "../tab", "tab id", "日本語"] {
            assert!(webview_label(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn bounds_reject_non_finite_and_empty_rectangles() {
        assert!(WebPaneBounds {
            x: 0.0,
            y: 1.0,
            width: 800.0,
            height: 600.0,
        }
        .validate()
        .is_ok());
        for bounds in [
            WebPaneBounds {
                x: f64::NAN,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            WebPaneBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 1.0,
            },
        ] {
            assert!(bounds.validate().is_err());
        }
    }

    #[test]
    fn forwarded_shortcuts_are_validated_and_deduplicated() {
        assert_eq!(
            validate_forwarded_shortcuts(vec![
                "ctrl+tab".to_string(),
                "ctrl+1".to_string(),
                "ctrl+tab".to_string(),
            ])
            .unwrap(),
            vec!["ctrl+1".to_string(), "ctrl+tab".to_string()]
        );
        for invalid in ["", "Ctrl+Tab", "ctrl tab", "日本語"] {
            assert!(validate_forwarded_shortcuts(vec![invalid.to_string()]).is_err());
        }
    }

    #[test]
    fn initialization_script_forwards_only_trusted_non_ime_matches() {
        let script = shortcut_initialization_script(
            "tab_1",
            &["ctrl+tab".to_string(), "ctrl+alt+pagedown".to_string()],
        )
        .unwrap();
        assert!(script.contains("event.isTrusted"));
        assert!(script.contains("event.isComposing"));
        assert!(script.contains("event.keyCode === 229"));
        assert!(script.contains("state.shortcuts.has"));
        assert!(script.contains("plugin:event|emit"));
        assert!(script.contains(WEB_PANE_KEYDOWN_EVENT));
        assert!(script.contains("ctrl+alt+pagedown"));
        assert!(!script.contains("ctrl+c"));
    }

    #[test]
    fn composer_push_inserts_without_submitting_by_default() {
        let script = composer_push_script("push-result", Some("draft only"), false).unwrap();
        assert!(script.contains("#prompt-textarea"));
        assert!(script.contains("InputEvent"));
        assert!(!script.contains("send-button"));
        assert!(!script.contains("submitButton.click()"));
    }

    #[test]
    fn composer_push_submits_only_when_explicitly_requested() {
        let draft = composer_push_script("push-result", Some("draft"), false).unwrap();
        let submitted = composer_push_script("push-result", Some("send"), true).unwrap();
        assert!(!draft.contains("submitButton.click()"));
        assert!(submitted.contains("submitButton.click()"));
        assert!(submitted.contains("send-button"));
    }

    #[test]
    fn composer_push_json_encodes_quotes_newlines_backslashes_and_script_text() {
        let text = "quote: \"hello\"\npath: C:\\tmp\\file\n</script>";
        let encoded = serde_json::to_string(text).unwrap();
        let script = composer_push_script("push-result", Some(text), false).unwrap();
        assert!(script.contains(&format!("const text = {encoded};")));
        assert!(!script.contains("const text = \"quote: \"hello\""));
    }

    #[test]
    fn composer_push_rejects_oversized_text_before_building_a_script() {
        let at_limit = "a".repeat(WEB_PANE_MAX_TEXT_BYTES);
        assert!(composer_push_script("push-result", Some(&at_limit), false).is_ok());
        let oversized = "a".repeat(WEB_PANE_MAX_TEXT_BYTES + 1);
        let error = composer_push_script("push-result", Some(&oversized), false).unwrap_err();
        assert!(error.contains("exceeds"));
        assert!(error.contains(&WEB_PANE_MAX_TEXT_BYTES.to_string()));
    }

    #[test]
    fn composer_push_requires_text_unless_submit_is_requested() {
        assert!(composer_push_script("push-result", None, false).is_err());
        assert!(composer_push_script("push-result", None, true).is_ok());
    }
}
