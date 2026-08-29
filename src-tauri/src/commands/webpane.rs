use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl, Window};

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
}
