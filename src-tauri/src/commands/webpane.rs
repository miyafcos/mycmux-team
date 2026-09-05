use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::webview::NewWindowResponse;
#[cfg(target_os = "macos")]
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder,
    WebviewUrl, Window,
};

/// How `web.push` reaches a service's message box. `None` on a preset means the
/// service is readable in a pane but has no wired composer -- pushing to it is
/// refused out loud rather than typing into whatever element happens to match.
#[derive(Clone, Copy, Debug)]
pub struct WebPaneComposer {
    /// The element text is inserted into.
    pub selector: &'static str,
    /// Tried before the enclosing form's `button[type=submit]`.
    pub submit_selector: &'static str,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPanePreset {
    pub id: &'static str,
    pub label: &'static str,
    pub url: &'static str,
    /// Folder under `web-profiles/`. Presets may share one: everything that
    /// signs in through Google shares `google`, so one login covers them all.
    pub profile_dir: &'static str,
    /// Hosts that stay inside the pane. A popup for anything else is handed to
    /// the OS browser -- the pane is not a general-purpose browser.
    #[serde(skip)]
    pub allowed_hosts: &'static [&'static str],
    /// URL substrings that mean "this service is showing a signed-out screen".
    #[serde(skip)]
    pub signed_out_patterns: &'static [&'static str],
    #[serde(skip)]
    pub composer: Option<WebPaneComposer>,
}

/// Sign-in popups are the same handful of identity providers for every service,
/// so they are allowed for all presets rather than repeated in each row.
const WEB_PANE_AUTH_HOSTS: &[&str] = &[
    "accounts.google.com",
    "accounts.youtube.com",
    "appleid.apple.com",
    "login.microsoftonline.com",
    "login.live.com",
    "auth.openai.com",
    "auth0.openai.com",
    "x.com",
    "twitter.com",
];

const WEB_PANE_PRESETS: &[WebPanePreset] = &[
    WebPanePreset {
        id: "chatgpt",
        label: "ChatGPT",
        url: "https://chatgpt.com/",
        profile_dir: "google",
        allowed_hosts: &["chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com"],
        signed_out_patterns: &["chatgpt.com/auth/", "auth.openai.com", "auth0.openai.com"],
        composer: Some(WebPaneComposer {
            selector: "#prompt-textarea",
            submit_selector: "[data-testid=\"send-button\"]",
        }),
    },
    WebPanePreset {
        id: "gemini",
        label: "Gemini",
        url: "https://gemini.google.com/app",
        profile_dir: "google",
        allowed_hosts: &["gemini.google.com", "google.com", "gstatic.com"],
        signed_out_patterns: &["accounts.google.com"],
        composer: Some(WebPaneComposer {
            selector: "rich-textarea .ql-editor",
            submit_selector: "button[aria-label*=\"Send\"], button.send-button",
        }),
    },
    WebPanePreset {
        id: "grok",
        label: "Grok",
        url: "https://grok.com/",
        profile_dir: "grok",
        allowed_hosts: &["grok.com", "x.ai", "x.com", "twitter.com"],
        signed_out_patterns: &["grok.com/sign-in", "x.com/i/flow/login", "accounts.google.com"],
        composer: Some(WebPaneComposer {
            selector: "textarea[aria-label], form textarea",
            submit_selector: "button[type=\"submit\"], button[aria-label*=\"Submit\"]",
        }),
    },
    WebPanePreset {
        id: "claude",
        label: "Claude.ai",
        url: "https://claude.ai/",
        profile_dir: "google",
        allowed_hosts: &["claude.ai", "anthropic.com"],
        signed_out_patterns: &["claude.ai/login", "accounts.google.com"],
        composer: Some(WebPaneComposer {
            selector: "div[contenteditable=\"true\"].ProseMirror",
            submit_selector: "button[aria-label*=\"Send\"]",
        }),
    },
    WebPanePreset {
        id: "notebooklm",
        label: "NotebookLM",
        url: "https://notebooklm.google.com/",
        profile_dir: "google",
        allowed_hosts: &["notebooklm.google.com", "google.com", "gstatic.com"],
        signed_out_patterns: &["accounts.google.com"],
        // Notebook-scoped chat has no stable composer selector worth guessing at.
        composer: None,
    },
];

const WEB_PANE_KEYDOWN_EVENT: &str = "mycmux:web-pane-keydown";
const WEB_PANE_URL_EVENT: &str = "mycmux:web-pane-url";
#[cfg(target_os = "windows")]
const WEB_PANE_SIGNIN_EVENT: &str = "mycmux:web-pane-signin";
const WEB_PANE_SHORTCUT_STATE: &str = "__MYCMUX_WEB_PANE_SHORTCUT_STATE__";
const WEB_PANE_PUSH_TIMEOUT: Duration = Duration::from_secs(5);
const WEB_PANE_MAX_TEXT_BYTES: usize = 256 * 1024;
/// How long the browser process gets to release the profile folder after its
/// last webview closes, before the sign-in window is launched anyway.
#[cfg(target_os = "windows")]
const WEB_PANE_PROFILE_RELEASE_TIMEOUT: Duration = Duration::from_secs(15);
/// A sign-in browser that dies inside this window never showed a window: it was
/// handed off to an instance that already owned the profile folder.
#[cfg(target_os = "windows")]
const WEB_PANE_SIGNIN_LIVENESS_DELAY: Duration = Duration::from_secs(2);
static WEB_PANE_PUSH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// webview label -> preset id, so sign-in knows which panes share a profile.
static WEB_PANE_OPEN_PRESETS: OnceLock<DashMap<String, &'static str>> = OnceLock::new();
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

/// WKWebView ignores `data_directory`, so macOS 14+ needs a stable custom data
/// store. The namespace prevents an accidental collision with another hash use,
/// while `profile_dir` preserves the sharing declared by the preset registry.
#[cfg(target_os = "macos")]
fn macos_data_store_identifier(profile_dir: &str) -> [u8; 16] {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(
        [b"com.miyazaki.mycmux/web-pane/".as_slice(), profile_dir.as_bytes()].concat(),
    );
    let mut identifier = [0_u8; 16];
    identifier.copy_from_slice(&digest[..16]);
    identifier
}

/// WebView2 keeps its profile in an `EBWebView` folder under the data directory
/// it is handed. A sign-in browser has to be pointed at that folder, not at its
/// parent -- aiming one level too high seeds a profile nothing ever reads.
#[cfg(target_os = "windows")]
fn webview2_user_data_directory(profile_dir: &Path) -> PathBuf {
    profile_dir.join("EBWebView")
}

/// While a Chromium browser process owns a user data folder it keeps a
/// `lockfile` there, and removes it on a clean exit. That is the signal for
/// "the folder is free now".
#[cfg(target_os = "windows")]
fn profile_lock_file(profile_dir: &Path) -> PathBuf {
    webview2_user_data_directory(profile_dir).join("lockfile")
}

/// `std::fs::canonicalize` returns an extended-length (`\\?\`) path on Windows,
/// and Chromium's sandboxed network service will not create its cookie database
/// under one: the profile loads, browsing history and local storage persist,
/// and every cookie silently lives in memory until the app closes. Measured
/// 2026-09-03 by running one Edge build against the same page with the same
/// folder in both spellings -- `Cookies` and `Cookies-journal` were the only
/// difference. `dunce` keeps the short spelling whenever Windows accepts it.
fn normalize_profile_directory(profile_dir: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(profile_dir)
        .map_err(|error| format!("failed to canonicalize web pane profile directory: {error}"))
}

fn host_matches(host: &str, allowed: &[&str]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    allowed.iter().any(|candidate| {
        let candidate = candidate.to_ascii_lowercase();
        host == candidate || host.ends_with(&format!(".{candidate}"))
    })
}

fn preset_keeps_url_inside_pane(preset: WebPanePreset, url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    host_matches(host, preset.allowed_hosts) || host_matches(host, WEB_PANE_AUTH_HOSTS)
}

#[cfg(target_os = "macos")]
fn page_load_reports_status(event: PageLoadEvent) -> bool {
    matches!(event, PageLoadEvent::Finished)
}

/// Two signals, because either one alone is unreliable. Being parked on
/// somebody else's host means an identity provider has the page -- that catches
/// every Google service without guessing a path. The explicit patterns catch
/// the login screens a service serves from its own host, where the first rule
/// sees nothing wrong. A missed signal is not cosmetic: the sign-in button
/// lives on this bar, so a service that never reports signed out is a service
/// the operator cannot fix.
fn url_looks_signed_out(preset: WebPanePreset, url: &str) -> bool {
    if preset
        .signed_out_patterns
        .iter()
        .any(|pattern| url.contains(pattern))
    {
        return true;
    }
    let Ok(parsed) = url.parse::<Url>() else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Ok(own_host) = composer_host(preset) else {
        return false;
    };
    !host_matches(parsed.host_str().unwrap_or_default(), &[own_host.as_str()])
}

/// The composer only fires on the service's own site. Derived from the preset
/// URL so a new preset cannot forget to declare it.
fn composer_host(preset: WebPanePreset) -> Result<String, String> {
    let url: Url = preset
        .url
        .parse()
        .map_err(|error| format!("invalid web pane preset URL: {error}"))?;
    url.host_str()
        .map(|host| host.to_ascii_lowercase())
        .ok_or_else(|| format!("web pane preset {} has no host", preset.id))
}

fn open_presets() -> &'static DashMap<String, &'static str> {
    WEB_PANE_OPEN_PRESETS.get_or_init(DashMap::new)
}

fn preset_for_label(label: &str) -> Option<WebPanePreset> {
    let id = open_presets().get(label).map(|entry| *entry.value())?;
    preset_by_id(id).ok()
}

#[cfg(target_os = "windows")]
fn tab_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix("web-pane-")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebPaneUrlPayload {
    tab_id: String,
    preset_id: String,
    url: String,
    signed_out: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(target_os = "windows")]
struct WebPaneSigninPayload {
    profile_dir: String,
    tab_ids: Vec<String>,
    state: &'static str,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPaneSigninResult {
    profile_dir: String,
    tab_ids: Vec<String>,
    browser_path: String,
    external_signin_required: bool,
}

#[cfg(target_os = "macos")]
fn direct_signin_result(preset: WebPanePreset) -> WebPaneSigninResult {
    WebPaneSigninResult {
        profile_dir: preset.profile_dir.to_string(),
        tab_ids: Vec::new(),
        browser_path: String::new(),
        external_signin_required: false,
    }
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
    preset: WebPanePreset,
    request_id: &str,
    text: Option<&str>,
    submit: bool,
) -> Result<String, String> {
    let composer = preset.composer.ok_or_else(|| {
        format!(
            "web pane push is not wired for {}: it has no composer selector",
            preset.label
        )
    })?;
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
    let service = serde_json::to_string(preset.label)
        .map_err(|error| format!("failed to serialize web pane service label: {error}"))?;
    let composer_selector = serde_json::to_string(composer.selector)
        .map_err(|error| format!("failed to serialize web pane composer selector: {error}"))?;
    let submit_selector = serde_json::to_string(composer.submit_selector)
        .map_err(|error| format!("failed to serialize web pane submit selector: {error}"))?;
    let insert_script = match text {
        Some(text) => {
            let text = serde_json::to_string(text)
                .map_err(|error| format!("failed to serialize web pane text: {error}"))?;
            format!(
                r#"const text = {text};
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {{
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error(service + " composer value setter is unavailable");
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
        const submitButton = document.querySelector(submitSelector)
          ?? composer.closest("form")?.querySelector('button[type="submit"]');
        if (!(submitButton instanceof HTMLButtonElement)) {
          throw new Error(service + " submit button was not found");
        }
        if (submitButton.disabled) throw new Error(service + " submit button is disabled");
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
  const service = {service};
  const composerSelector = {composer_selector};
  const submitSelector = {submit_selector};
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
    const composer = document.querySelector(composerSelector);
    if (!(composer instanceof HTMLElement)) {{
      throw new Error(service + " composer " + composerSelector + " was not found");
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
        // Re-assert the mapping: a sign-in run drops it while the webview is
        // being torn down, and push needs to know the service either way.
        open_presets().insert(label.clone(), preset_by_id(&preset_id)?.id);
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
    let profile_dir = normalize_profile_directory(&profile_dir)?;
    let url = preset
        .url
        .parse()
        .map_err(|error| format!("invalid web pane preset URL: {error}"))?;

    let page_load_app = app.clone();
    let page_load_tab_id = tab_id.clone();
    let new_window_app = app.clone();
    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
        .focused(false)
        .data_directory(profile_dir)
        .initialization_script(shortcut_initialization_script(
            &tab_id,
            &forwarded_shortcuts,
        )?);
    #[cfg(target_os = "macos")]
    let builder = {
        let identifier = macos_data_store_identifier(preset.profile_dir);
        eprintln!(
            "[web-pane] macOS data store profile={} identifier={}",
            preset.profile_dir,
            hex::encode(identifier)
        );
        // Tauri forwards this to wry's WebViewBuilderExtDarwin. wry selects the
        // custom store on macOS 14+ and its default store on older macOS.
        builder.data_store_identifier(identifier)
    };
    let builder = builder
        .on_page_load(move |_webview, payload| {
            // Started fires for redirects too. Only a completed top-level URL
            // is allowed to become the status bar's signed-in/out state.
            #[cfg(target_os = "macos")]
            if !page_load_reports_status(payload.event()) {
                return;
            }
            let url = payload.url().to_string();
            let _ = page_load_app.emit(
                WEB_PANE_URL_EVENT,
                WebPaneUrlPayload {
                    tab_id: page_load_tab_id.clone(),
                    preset_id: preset.id.to_string(),
                    signed_out: url_looks_signed_out(preset, &url),
                    url,
                },
            );
        })
        // Without a handler wry answers every window.open with SetHandled(true),
        // which is why "continue with Google" did nothing at all: the OAuth
        // popup was swallowed before it could be refused or shown.
        .on_new_window(move |url, _features| {
            if preset_keeps_url_inside_pane(preset, &url) {
                return NewWindowResponse::Allow;
            }
            open_in_os_browser(&new_window_app, url.as_str());
            NewWindowResponse::Deny
        });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| format!("failed to create web pane: {error}"))?;
    open_presets().insert(label.clone(), preset.id);
    webview
        .show()
        .map_err(|error| format!("failed to show web pane: {error}"))?;
    Ok(label)
}

fn open_in_os_browser(app: &AppHandle, url: &str) {
    use tauri_plugin_shell::ShellExt;
    // tauri-plugin-opener is the un-deprecated route, but it is not installed
    // here and one call does not earn a new plugin. The shell plugin already
    // ships with the app and does the same thing.
    #[allow(deprecated)]
    let opened = app.shell().open(url, None);
    if let Err(error) = opened {
        eprintln!("[web-pane] failed to open {url} in the OS browser: {error}");
    }
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
    open_presets().remove(&label);
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|error| format!("failed to destroy web pane: {error}"))?;
    }
    Ok(())
}

/// Start the platform's sign-in flow. Windows opens Edge against the pane's
/// WebView2 profile; macOS reports that WKWebView can sign in directly.
#[tauri::command]
pub async fn webpane_signin(
    app: AppHandle,
    preset_id: String,
) -> Result<WebPaneSigninResult, String> {
    let preset = preset_by_id(&preset_id)?;

    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        // WKWebView uses Safari's engine and can complete Google OAuth inside
        // the pane. There is no external-profile handoff to perform on macOS.
        Ok(direct_signin_result(preset))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = &app;
        Err("external web-pane sign-in is not supported on this platform".to_string())
    }

    #[cfg(target_os = "windows")]
    {
        webpane_signin_windows(app, preset).await
    }
}

#[cfg(target_os = "windows")]
async fn webpane_signin_windows(
    app: AppHandle,
    preset: WebPanePreset,
) -> Result<WebPaneSigninResult, String> {
    let browser = find_signin_browser()?;
    let local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve local app data directory: {error}"))?;
    let profile_dir = profile_directory(
        crate::test_profile::app_data_dir_from(local_data_dir),
        preset,
    )?;
    let user_data_dir = webview2_user_data_directory(&profile_dir);
    std::fs::create_dir_all(&user_data_dir)
        .map_err(|error| format!("failed to create web pane profile directory: {error}"))?;

    // Every pane on this profile has to let go of the folder first: two browser
    // processes cannot own one user data folder.
    let closing: Vec<(String, String)> = open_presets()
        .iter()
        .filter(|entry| {
            preset_by_id(entry.value())
                .map(|other| other.profile_dir == preset.profile_dir)
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let label = entry.key().clone();
            tab_id_from_label(&label).map(|tab| (label.clone(), tab.to_string()))
        })
        .collect();
    let tab_ids: Vec<String> = closing.iter().map(|(_, tab)| tab.clone()).collect();
    for (label, _) in &closing {
        open_presets().remove(label);
        if let Some(webview) = app.get_webview(label) {
            let _ = webview.close();
        }
    }
    let _ = app.emit(
        WEB_PANE_SIGNIN_EVENT,
        WebPaneSigninPayload {
            profile_dir: preset.profile_dir.to_string(),
            tab_ids: tab_ids.clone(),
            state: "running",
            error: None,
        },
    );

    wait_for_profile_release(&profile_dir).await;

    let mut child = std::process::Command::new(&browser)
        .arg(format!("--user-data-dir={}", user_data_dir.display()))
        .arg("--no-first-run")
        .arg(preset.url)
        .spawn()
        .map_err(|error| {
            let message = format!("failed to start the sign-in browser: {error}");
            emit_signin_finished(&app, preset, tab_ids.clone(), Some(message.clone()));
            message
        })?;

    tokio::time::sleep(WEB_PANE_SIGNIN_LIVENESS_DELAY).await;
    if matches!(child.try_wait(), Ok(Some(_))) {
        let message = format!(
            "the sign-in browser exited immediately -- the {} profile is still held by another process. Close the {} panes (or mycmux) and try again.",
            preset.profile_dir, preset.label
        );
        emit_signin_finished(&app, preset, tab_ids.clone(), Some(message.clone()));
        return Err(message);
    }

    let finish_app = app.clone();
    let finish_tabs = tab_ids.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let error = child.wait().err().map(|error| error.to_string());
        emit_signin_finished(&finish_app, preset, finish_tabs, error);
    });

    Ok(WebPaneSigninResult {
        profile_dir: preset.profile_dir.to_string(),
        tab_ids,
        browser_path: browser.display().to_string(),
        external_signin_required: true,
    })
}

#[cfg(target_os = "windows")]
fn emit_signin_finished(
    app: &AppHandle,
    preset: WebPanePreset,
    tab_ids: Vec<String>,
    error: Option<String>,
) {
    let _ = app.emit(
        WEB_PANE_SIGNIN_EVENT,
        WebPaneSigninPayload {
            profile_dir: preset.profile_dir.to_string(),
            tab_ids,
            state: if error.is_some() { "failed" } else { "finished" },
            error,
        },
    );
}

#[cfg(target_os = "windows")]
async fn wait_for_profile_release(profile_dir: &Path) {
    let lock = profile_lock_file(profile_dir);
    let deadline = std::time::Instant::now() + WEB_PANE_PROFILE_RELEASE_TIMEOUT;
    while lock.exists() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// The sign-in window has to be Edge: WebView2 *is* Edge, so the two write the
/// same profile format and use the same DPAPI cookie key. A different browser
/// would leave a profile WebView2 cannot read.
#[cfg(target_os = "windows")]
fn find_signin_browser() -> Result<PathBuf, String> {
    let candidates = [
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("ProgramFiles"),
        std::env::var_os("LOCALAPPDATA"),
    ];
    for base in candidates.into_iter().flatten() {
        let path = PathBuf::from(base)
            .join("Microsoft")
            .join("Edge")
            .join("Application")
            .join("msedge.exe");
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(
        "Microsoft Edge was not found, so the sign-in window cannot be opened. WebView2 shares Edge's profile format, so the sign-in has to happen in Edge."
            .to_string(),
    )
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
    let preset = preset_for_label(&label)
        .ok_or_else(|| format!("web pane {tab_id} has no known preset"))?;
    let current_url = webview
        .url()
        .map_err(|error| format!("failed to read web pane URL: {error}"))?;
    let host = current_url.host_str().unwrap_or_default();
    let expected_host = composer_host(preset)?;
    if !host_matches(host, &[expected_host.as_str()]) {
        return Err(format!(
            "web pane is not on an allowed {} composer host: {host}",
            preset.label
        ));
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let script = composer_push_script(preset, &request_id, text.as_deref(), submit)?;
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
    fn preset_registry_is_generic_and_resolves_every_service() {
        assert_eq!(WEB_PANE_PRESETS.len(), 5);
        for id in ["chatgpt", "gemini", "grok", "claude", "notebooklm"] {
            let preset = preset_by_id(id).unwrap();
            assert!(!preset.label.is_empty(), "{id}");
            assert!(preset.url.starts_with("https://"), "{id}");
            assert!(
                safe_directory_component(preset.profile_dir).is_ok(),
                "{id} has an unusable profile directory"
            );
            assert!(!preset.signed_out_patterns.is_empty(), "{id}");
            assert!(!preset.allowed_hosts.is_empty(), "{id}");
            assert!(composer_host(preset).is_ok(), "{id}");
        }
        let preset = preset_by_id("chatgpt").unwrap();
        assert_eq!(preset.label, "ChatGPT");
        assert_eq!(preset.url, "https://chatgpt.com/");
        assert!(preset_by_id("missing").is_err());
    }

    #[test]
    fn google_services_share_one_profile_so_one_login_covers_them() {
        // The point of the shared folder: signing in to Google once has to be
        // enough for every service that federates through it.
        for id in ["chatgpt", "gemini", "claude", "notebooklm"] {
            assert_eq!(preset_by_id(id).unwrap().profile_dir, "google", "{id}");
        }
        // Grok signs in through X, so it keeps its own.
        assert_eq!(preset_by_id("grok").unwrap().profile_dir, "grok");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_data_store_identifier_is_deterministic_and_profile_scoped() {
        let first_launch = macos_data_store_identifier("google");
        let second_launch = macos_data_store_identifier("google");
        eprintln!(
            "[web-pane] deterministic test profile=google identifier={}",
            hex::encode(first_launch)
        );
        assert_eq!(first_launch, second_launch);
        assert_ne!(first_launch, macos_data_store_identifier("grok"));
        assert_eq!(first_launch.len(), 16);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_signin_contract_requires_no_external_browser() {
        let result = direct_signin_result(preset_by_id("chatgpt").unwrap());
        assert_eq!(result.profile_dir, "google");
        assert!(result.tab_ids.is_empty());
        assert!(result.browser_path.is_empty());
        assert!(!result.external_signin_required);
    }

    #[test]
    fn profile_directory_stays_below_web_profiles() {
        let preset = preset_by_id("chatgpt").unwrap();
        let base = PathBuf::from(r"C:\Users\test\AppData\Local\com.miyazaki.mycmux");
        assert_eq!(
            profile_directory(base.clone(), preset).unwrap(),
            base.join("web-profiles").join("google")
        );
        let invalid = WebPanePreset {
            profile_dir: "../escape",
            ..preset
        };
        assert!(profile_directory(base, invalid).is_err());
    }

    #[test]
    fn the_profile_path_handed_to_webview2_is_never_an_extended_length_path() {
        // Regression guard for the cookie bug: with a `\\?\` prefix Chromium's
        // network service never creates Default\Network\Cookies, so every login
        // is lost when the app closes. Nothing about the pane looks broken --
        // history and local storage still persist -- so only a test catches it.
        let base = std::env::temp_dir().join("mycmux-webpane-normalize-test");
        std::fs::create_dir_all(&base).unwrap();
        let normalized = normalize_profile_directory(&base).unwrap();
        let rendered = normalized.to_string_lossy().into_owned();
        assert!(
            !rendered.starts_with(r"\\?\"),
            "web pane profile path must not be extended-length: {rendered}"
        );
        assert!(normalized.is_absolute());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_sign_in_browser_is_pointed_at_the_folder_webview2_actually_reads() {
        // Seeding <profile>\Default instead of <profile>\EBWebView\Default is
        // how the 2026-08-28 spike concluded the handoff worked while the pane
        // kept none of the cookies.
        let profile = PathBuf::from(r"C:\profiles\google");
        assert_eq!(
            webview2_user_data_directory(&profile),
            profile.join("EBWebView")
        );
        assert_eq!(
            profile_lock_file(&profile),
            profile.join("EBWebView").join("lockfile")
        );
    }

    #[test]
    fn host_matching_covers_subdomains_without_matching_lookalikes() {
        assert!(host_matches("chatgpt.com", &["chatgpt.com"]));
        assert!(host_matches("cdn.chatgpt.com", &["chatgpt.com"]));
        assert!(host_matches("CHATGPT.COM.", &["chatgpt.com"]));
        assert!(!host_matches("notchatgpt.com", &["chatgpt.com"]));
        assert!(!host_matches("chatgpt.com.evil.example", &["chatgpt.com"]));
        assert!(!host_matches("", &["chatgpt.com"]));
    }

    #[test]
    fn oauth_popups_stay_in_the_pane_and_everything_else_leaves() {
        let inside_flows = [
            ("chatgpt", "https://chatgpt.com/c/abc"),
            ("chatgpt", "https://auth.openai.com/authorize"),
            ("gemini", "https://accounts.google.com/o/oauth2/v2/auth"),
            ("notebooklm", "https://notebook.google.com/login"),
            ("claude", "https://accounts.google.com/o/oauth2/v2/auth"),
            ("grok", "https://accounts.x.ai/sign-in"),
            ("grok", "https://x.com/i/flow/login"),
            ("grok", "https://accounts.google.com/o/oauth2/v2/auth"),
            ("grok", "https://appleid.apple.com/auth/authorize"),
        ];
        for (preset_id, inside) in inside_flows {
            let preset = preset_by_id(preset_id).unwrap();
            assert!(
                preset_keeps_url_inside_pane(preset, &inside.parse().unwrap()),
                "{preset_id}: {inside}"
            );
        }
        let preset = preset_by_id("chatgpt").unwrap();
        for outside in ["https://example.com/", "https://github.com/anthropics"] {
            assert!(
                !preset_keeps_url_inside_pane(preset, &outside.parse().unwrap()),
                "{outside}"
            );
        }
    }

    #[test]
    fn signed_out_screens_are_recognised_per_service() {
        let chatgpt = preset_by_id("chatgpt").unwrap();
        // Same host, login path: only the explicit pattern sees this.
        assert!(url_looks_signed_out(
            chatgpt,
            "https://chatgpt.com/auth/login"
        ));
        assert!(!url_looks_signed_out(chatgpt, "https://chatgpt.com/c/abc"));
        assert!(!url_looks_signed_out(chatgpt, "https://cdn.chatgpt.com/x"));
        let gemini = preset_by_id("gemini").unwrap();
        assert!(url_looks_signed_out(
            gemini,
            "https://accounts.google.com/ServiceLogin"
        ));
        assert!(!url_looks_signed_out(
            gemini,
            "https://gemini.google.com/app/1234"
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn signed_out_status_waits_for_the_finished_url() {
        assert!(!page_load_reports_status(PageLoadEvent::Started));
        assert!(page_load_reports_status(PageLoadEvent::Finished));
    }

    #[test]
    fn a_service_parked_on_someone_elses_host_counts_as_signed_out() {
        // The sign-in button lives on the bar this drives, so a preset whose
        // login path was guessed wrong must still be reachable. Sitting on an
        // identity provider is the signal that needs no guessing.
        for id in ["chatgpt", "gemini", "grok", "claude", "notebooklm"] {
            let preset = preset_by_id(id).unwrap();
            assert!(
                url_looks_signed_out(preset, "https://accounts.google.com/ServiceLogin"),
                "{id}"
            );
            assert!(
                !url_looks_signed_out(preset, preset.url),
                "{id} reads its own landing page as signed out"
            );
        }
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

    fn chatgpt() -> WebPanePreset {
        preset_by_id("chatgpt").unwrap()
    }

    #[test]
    fn composer_push_inserts_without_submitting_by_default() {
        let script = composer_push_script(chatgpt(), "push-result", Some("draft only"), false)
            .unwrap();
        assert!(script.contains("#prompt-textarea"));
        assert!(script.contains("InputEvent"));
        assert!(!script.contains("submitButton.click()"));
    }

    #[test]
    fn composer_push_submits_only_when_explicitly_requested() {
        let draft = composer_push_script(chatgpt(), "push-result", Some("draft"), false).unwrap();
        let submitted =
            composer_push_script(chatgpt(), "push-result", Some("send"), true).unwrap();
        assert!(!draft.contains("submitButton.click()"));
        assert!(submitted.contains("submitButton.click()"));
        assert!(submitted.contains("send-button"));
    }

    #[test]
    fn composer_push_uses_the_selectors_of_the_service_it_targets() {
        let gemini = preset_by_id("gemini").unwrap();
        let script = composer_push_script(gemini, "push-result", Some("hello"), false).unwrap();
        assert!(script.contains("rich-textarea .ql-editor"));
        assert!(script.contains("Gemini"));
        assert!(!script.contains("#prompt-textarea"));
    }

    #[test]
    fn composer_push_refuses_a_service_with_no_wired_composer() {
        let notebooklm = preset_by_id("notebooklm").unwrap();
        let error = composer_push_script(notebooklm, "push-result", Some("hello"), false)
            .unwrap_err();
        assert!(error.contains("NotebookLM"));
        assert!(error.contains("composer"));
    }

    #[test]
    fn composer_push_json_encodes_quotes_newlines_backslashes_and_script_text() {
        let text = "quote: \"hello\"\npath: C:\\tmp\\file\n</script>";
        let encoded = serde_json::to_string(text).unwrap();
        let script = composer_push_script(chatgpt(), "push-result", Some(text), false).unwrap();
        assert!(script.contains(&format!("const text = {encoded};")));
        assert!(!script.contains("const text = \"quote: \"hello\""));
    }

    #[test]
    fn composer_push_rejects_oversized_text_before_building_a_script() {
        let at_limit = "a".repeat(WEB_PANE_MAX_TEXT_BYTES);
        assert!(composer_push_script(chatgpt(), "push-result", Some(&at_limit), false).is_ok());
        let oversized = "a".repeat(WEB_PANE_MAX_TEXT_BYTES + 1);
        let error = composer_push_script(chatgpt(), "push-result", Some(&oversized), false)
            .unwrap_err();
        assert!(error.contains("exceeds"));
        assert!(error.contains(&WEB_PANE_MAX_TEXT_BYTES.to_string()));
    }

    #[test]
    fn composer_push_requires_text_unless_submit_is_requested() {
        assert!(composer_push_script(chatgpt(), "push-result", None, false).is_err());
        assert!(composer_push_script(chatgpt(), "push-result", None, true).is_ok());
    }
}
