use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::webview::PageLoadEvent;
use tauri::webview::{DownloadEvent, NewWindowResponse};
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

#[derive(Clone, Copy, Debug)]
pub struct WebPaneReader {
    pub assistant: &'static str,
    pub user: &'static str,
    pub generating: &'static str,
    pub composer: &'static str,
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
    #[serde(skip)]
    pub reader: Option<WebPaneReader>,
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
        id: "browser",
        label: "Browser",
        url: "about:blank",
        profile_dir: "ai",
        allowed_hosts: &[],
        signed_out_patterns: &[],
        composer: None,
        reader: None,
    },
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
        // oracmux/scripts/engines.json 2026-09-07
        reader: Some(WebPaneReader {
            assistant: r#"[data-message-author-role="assistant"]"#,
            user: r#"[data-message-author-role="user"]"#,
            generating: r#"[data-testid="stop-button"]"#,
            composer: r#"#prompt-textarea"#,
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
            // The Gemini UI is served in the account's language: the send
            // button is `プロンプトを送信` for a Japanese account (measured
            // 2026-08-23 / 09-07), `Send message` for English.
            submit_selector: "button[aria-label=\"プロンプトを送信\"], button[aria-label*=\"送信\"], button[aria-label*=\"Send\"], button.send-button",
        }),
        // oracmux/scripts/engines.json 2026-09-07
        reader: Some(WebPaneReader {
            assistant: r#"model-response"#,
            user: r#"user-query"#,
            generating: r#"button[aria-label*="停止"], button[aria-label*="Stop"]"#,
            composer: r#"rich-textarea .ql-editor"#,
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
            selector: r#"div.tiptap[role="textbox"], [data-testid="chat-input"] [role="textbox"]"#,
            submit_selector: r#"[data-testid="chat-submit"], form button[type="submit"]"#,
        }),
        // oracmux/scripts/engines.json 2026-09-07
        reader: Some(WebPaneReader {
            assistant: r#"[data-testid="assistant-message"]"#,
            user: r#"[data-testid="user-message"]"#,
            generating: r#"button[aria-label="Stop"], button[aria-label*="Stop"]"#,
            composer: r#"div.tiptap[role="textbox"]"#,
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
        reader: None,
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
        reader: None,
    },
];

const WEB_PANE_KEYDOWN_EVENT: &str = "mycmux:web-pane-keydown";
const WEB_PANE_URL_EVENT: &str = "mycmux:web-pane-url";
#[cfg(target_os = "windows")]
const WEB_PANE_SIGNIN_EVENT: &str = "mycmux:web-pane-signin";
const WEB_PANE_SHORTCUT_STATE: &str = "__MYCMUX_WEB_PANE_SHORTCUT_STATE__";
const WEB_PANE_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Where a background web tab's webview is parked while its tab is not the
/// active one. Hiding the control (IsVisible=false) makes the page think it is
/// hidden and pauses requestAnimationFrame, which stops Gemini's streamed
/// answer from ever reaching the DOM (2026-09-07). Parking it far outside the
/// window keeps the page visible to itself while nothing of it is painted.
const WEB_PANE_PARKED_POSITION: (f64, f64) = (-20000.0, -20000.0);

fn park_webview(webview: &tauri::Webview) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(
            WEB_PANE_PARKED_POSITION.0,
            WEB_PANE_PARKED_POSITION.1,
        ))
        .map_err(|error| format!("failed to park web pane: {error}"))?;
    webview
        .show()
        .map_err(|error| format!("failed to show parked web pane: {error}"))
}
const WEB_PANE_MAX_READ_BYTES: usize = 512 * 1024;
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

static WEB_PANE_READ_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
type WebPaneReadReply = Result<WebPaneReadResult, String>;
static WEB_PANE_READ_RESULTS: OnceLock<
    DashMap<String, (String, tokio::sync::oneshot::Sender<WebPaneReadReply>)>,
> = OnceLock::new();

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPaneReadTurn {
    role: String,
    text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPaneReadResult {
    tab_id: String,
    preset_id: String,
    url: String,
    title: String,
    signed_out: bool,
    composer_present: bool,
    generating: bool,
    turns: Vec<WebPaneReadTurn>,
    last_assistant: String,
    last_assistant_links: Vec<String>,
    /// Unicode code points in retained turn text.
    chars: usize,
    truncated: bool,
}

fn initial_webpane_url(preset: WebPanePreset, initial_url: Option<&str>) -> Result<Url, String> {
    let value = initial_url.unwrap_or(preset.url);
    if preset.id == "browser" && value == "about:blank" {
        return value
            .parse()
            .map_err(|error| format!("invalid web pane URL: {error}"));
    }
    let url: Url = value
        .parse()
        .map_err(|error| format!("invalid web pane URL: {error}"))?;
    if !preset_keeps_url_inside_pane(preset, &url) {
        return Err(format!(
            "web pane url is outside the preset's allowed hosts: {value}"
        ));
    }
    Ok(url)
}

fn read_script(preset: WebPanePreset, request_id: &str) -> Result<String, String> {
    let reader = preset.reader.ok_or_else(|| {
        format!(
            "web pane read is not wired for {}: it has no reader",
            preset.label
        )
    })?;
    let config = serde_json::json!({
        "assistant": reader.assistant, "user": reader.user,
        "generating": reader.generating, "composer": reader.composer,
        "requestId": request_id, "presetId": preset.id,
        "host": composer_host(preset)?, "limit": WEB_PANE_MAX_READ_BYTES,
    });
    Ok(format!(
        r#"(() => {{
  const config = {config};
  const reply = (result, error) => window.__TAURI_INTERNALS__.invoke("webpane_read_result", {{
    requestId: config.requestId, result, error
  }}).catch(() => undefined);
  try {{
    const host = location.hostname.toLowerCase().replace(/\.$/, "");
    if (host !== config.host && !host.endsWith("." + config.host)) throw new Error("web pane read host changed");
    const nodes = [...document.querySelectorAll(config.user + ", " + config.assistant)];
    const turns = nodes.map(node => ({{
      role: node.matches(config.assistant) ? "assistant" : "user", text: node.innerText || ""
    }}));
    const last = nodes.filter(node => node.matches(config.assistant)).pop();
    const result = {{
      tabId: "", presetId: config.presetId, url: location.href, title: document.title,
      signedOut: false, composerPresent: document.querySelector(config.composer) !== null,
      generating: [...document.querySelectorAll(config.generating)].some(node =>
        node.offsetParent !== null || node.getClientRects().length > 0),
      turns, lastAssistant: last?.innerText || "",
      lastAssistantLinks: last ? [...last.querySelectorAll('a[href^="http"]')].map(a => a.href) : [],
      chars: 0, truncated: false
    }};
    // Reserve space for the native tab id (at most 128 ASCII bytes).
    const limit = config.limit - 128;
    const size = () => new TextEncoder().encode(JSON.stringify(result)).length;
    result.chars = turns.reduce((n, turn) => n + [...turn.text].length, 0);
    if (size() > limit) {{
      result.truncated = true;
      // Drop complete oldest turns first, counting UTF-8 JSON bytes, not UTF-16 units.
      while (result.turns.length && size() > limit) {{
        result.chars -= [...result.turns.shift().text].length;
      }}
      while (result.lastAssistantLinks.length && size() > limit) result.lastAssistantLinks.shift();
      // A single answer or metadata field can itself exceed the entire budget.
      // Keep its prefix without splitting a Unicode code point.
      for (const field of ["lastAssistant", "title", "url"]) {{
        if (size() <= limit) break;
        const chars = [...result[field]];
        let low = 0, high = chars.length;
        result[field] = "";
        while (low < high) {{
          const mid = Math.ceil((low + high) / 2);
          result[field] = chars.slice(0, mid).join("");
          if (size() <= limit) low = mid; else high = mid - 1;
        }}
        result[field] = chars.slice(0, low).join("");
      }}
    }}
    void reply(result, null);
  }} catch (error) {{
    void reply(null, String(error?.message || error));
  }}
}})();"#
    ))
}

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
        [
            b"com.miyazaki.mycmux/web-pane/".as_slice(),
            profile_dir.as_bytes(),
        ]
        .concat(),
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
    if preset.id == "browser" {
        return url.scheme() == "https" && url.host_str().is_some()
            || url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    }
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

pub(crate) fn webview_label(tab_id: &str) -> Result<String, String> {
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
        // The send button is rendered by the page's framework after the
        // input event (Angular / React change detection), and it only exists
        // once the composer holds text. Poll for it briefly instead of
        // reading the DOM on the next tick (2026-09-07: Gemini's button was not
        // there yet at setTimeout(0)).
        r#"const findSubmit = () => {
      const candidate = document.querySelector(submitSelector)
        ?? composer.closest("form")?.querySelector('button[type="submit"]');
      return candidate instanceof HTMLButtonElement ? candidate : null;
    };
    let attempts = 0;
    const trySubmit = () => {
      try {
        const submitButton = findSubmit();
        if (!submitButton || submitButton.disabled) {
          attempts += 1;
          if (attempts < 30) {
            window.setTimeout(trySubmit, 100);
            return;
          }
          throw new Error(service + (submitButton ? " submit button is disabled" : " submit button was not found"));
        }
        submitButton.click();
        finish({ ok: true });
      } catch (error) {
        fail(error);
      }
    };
    window.setTimeout(trySubmit, 0);"#
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
    visible: Option<bool>,
    initial_url: Option<String>,
) -> Result<String, String> {
    let label = webview_label(&tab_id)?;
    let bounds = bounds.validate()?;
    let forwarded_shortcuts = validate_forwarded_shortcuts(forwarded_shortcuts)?;
    let preset = preset_by_id(&preset_id)?;
    let url = initial_webpane_url(preset, initial_url.as_deref())?;

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
        if visible == Some(false) {
            park_webview(&webview)?;
        } else {
            set_webview_bounds(&webview, bounds)?;
            webview
                .show()
                .map_err(|error| format!("failed to show web pane: {error}"))?;
        }
        return Ok(label);
    }

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
    let page_load_app = app.clone();
    let page_load_tab_id = tab_id.clone();
    let new_window_app = app.clone();
    let new_window_label = label.clone();
    let download_tab_id = tab_id.clone();
    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
        .focused(false)
        .data_directory(profile_dir)
        .initialization_script(automation_initialization_script(preset.id == "browser")?)
        .on_navigation(move |url| {
            preset.id != "browser"
                || url.as_str() == "about:blank"
                || preset_keeps_url_inside_pane(preset, url)
        })
        .on_download(move |_webview, event| handle_download(&download_tab_id, preset, event))
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
            if preset.id == "browser" {
                if preset_keeps_url_inside_pane(preset, &url) {
                    if let Some(webview) = new_window_app.get_webview(&new_window_label) {
                        let _ = webview.navigate(url);
                    }
                }
                return NewWindowResponse::Deny;
            }
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
    if visible == Some(false) {
        park_webview(&webview)?;
    } else {
        webview
            .show()
            .map_err(|error| format!("failed to show web pane: {error}"))?;
    }
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
    park: Option<bool>,
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
        // A background tab keeps rendering off-screen; a plain inactive tab
        // is hidden as before.
        if park == Some(true) {
            return park_webview(&webview);
        }
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
    if let Ok(mut state) = download_state().lock() {
        state.records.retain(|record| record.tab_id != tab_id);
        state.reserved.retain(|_, owner| owner != &tab_id);
    }
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
            state: if error.is_some() {
                "failed"
            } else {
                "finished"
            },
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
    let webview = command_webview(&caller, &app, &tab_id, "webpane_push")?;
    let preset = composer_preset(&webview, &tab_id)?;
    let (_pending, receiver) = start_evaluation(&webview, &WEB_PANE_PUSH_RESULTS, "push", |id| {
        composer_push_script(preset, id, text.as_deref(), submit)
    })?;

    let payload = match tokio::time::timeout(WEB_PANE_PUSH_TIMEOUT, receiver).await {
        Ok(Ok(payload)) => payload,
        Ok(Err(_)) => {
            return Err("web pane push result channel closed".to_string());
        }
        Err(_) => {
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
    complete_evaluation(
        &caller,
        &WEB_PANE_PUSH_RESULTS,
        &request_id,
        "push",
        WebPanePushEventPayload { ok, error },
    )
}

#[tauri::command]
pub async fn webpane_read(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
) -> Result<WebPaneReadResult, String> {
    if caller.label() != caller.window().label() {
        return Err("webpane_read is only available to the primary app webview".to_string());
    }
    let _read_guard = WEB_PANE_READ_LOCK.lock().await;
    let webview = command_webview(&caller, &app, &tab_id, "webpane_read")?;
    let preset = composer_preset(&webview, &tab_id)?;
    let (_pending, receiver) = start_evaluation(&webview, &WEB_PANE_READ_RESULTS, "read", |id| {
        read_script(preset, id)
    })?;

    let payload = match tokio::time::timeout(WEB_PANE_READ_TIMEOUT, receiver).await {
        Ok(Ok(payload)) => payload,
        Ok(Err(_)) => {
            return Err("web pane read result channel closed".to_string());
        }
        Err(_) => {
            return Err("web pane read timed out waiting for the reader".to_string());
        }
    };
    let mut result = payload?;
    result.tab_id = tab_id;
    result.preset_id = preset.id.to_string();
    result.signed_out = url_looks_signed_out(preset, &result.url);
    result.chars = result
        .turns
        .iter()
        .map(|turn| turn.text.chars().count())
        .sum();
    if serde_json::to_vec(&result)
        .map_err(|error| error.to_string())?
        .len()
        > WEB_PANE_MAX_READ_BYTES
    {
        return Err("web pane read result exceeds the 512 KB limit".to_string());
    }
    Ok(result)
}

#[tauri::command]
pub async fn webpane_read_result(
    caller: Webview,
    request_id: String,
    result: Option<WebPaneReadResult>,
    error: Option<String>,
) -> Result<(), String> {
    let payload = match (result, error) {
        (_, Some(error)) => Err(error),
        (Some(result), None) => Ok(result),
        (None, None) => Err("web pane read returned no result".to_string()),
    };
    complete_evaluation(
        &caller,
        &WEB_PANE_READ_RESULTS,
        &request_id,
        "read",
        payload,
    )
}

type PendingReplies<T> = OnceLock<DashMap<String, (String, tokio::sync::oneshot::Sender<T>)>>;

struct PendingEvaluation<T: Send + 'static> {
    request_id: String,
    pending: &'static PendingReplies<T>,
}
impl<T: Send + 'static> Drop for PendingEvaluation<T> {
    fn drop(&mut self) {
        self.pending
            .get_or_init(DashMap::new)
            .remove(&self.request_id);
    }
}

fn start_evaluation<T: Send + 'static>(
    webview: &Webview,
    pending: &'static PendingReplies<T>,
    kind: &str,
    make_script: impl FnOnce(&str) -> Result<String, String>,
) -> Result<(PendingEvaluation<T>, tokio::sync::oneshot::Receiver<T>), String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let script = make_script(&request_id)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    pending
        .get_or_init(DashMap::new)
        .insert(request_id.clone(), (webview.label().to_string(), sender));
    let guard = PendingEvaluation {
        request_id,
        pending,
    };
    let evaluation = webview.eval(script);
    evaluation.map_err(|error| format!("failed to evaluate web pane {kind} script: {error}"))?;
    Ok((guard, receiver))
}

fn complete_evaluation<T: Send + 'static>(
    caller: &Webview,
    pending: &'static PendingReplies<T>,
    request_id: &str,
    kind: &str,
    payload: T,
) -> Result<(), String> {
    let pending = pending.get_or_init(DashMap::new);
    let expected_label = pending
        .get(request_id)
        .map(|entry| entry.value().0.clone())
        .ok_or_else(|| format!("unknown web pane {kind} request"))?;
    if caller.label() != expected_label {
        return Err(format!(
            "web pane {kind} result came from the wrong webview"
        ));
    }
    let (_, (_, sender)) = pending
        .remove(request_id)
        .ok_or_else(|| format!("web pane {kind} request already completed"))?;
    sender
        .send(payload)
        .map_err(|_| format!("web pane {kind} request receiver closed"))
}

fn command_webview(
    caller: &Webview,
    app: &AppHandle,
    tab_id: &str,
    command: &str,
) -> Result<Webview, String> {
    if caller.label() != caller.window().label() {
        return Err(format!(
            "{command} is only available to the primary app webview"
        ));
    }
    let label = webview_label(tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("web pane does not exist: {tab_id}"))?;
    if webview.window().label() != caller.window().label() {
        return Err(format!(
            "{command} cannot operate a web pane in another window"
        ));
    }
    Ok(webview)
}

fn composer_preset(webview: &Webview, tab_id: &str) -> Result<WebPanePreset, String> {
    let preset = preset_for_label(webview.label())
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
    Ok(preset)
}

#[derive(Debug)]
struct EvaluationFailure {
    message: String,
    csp_blocked: bool,
}

fn evaluation_failure(message: String, error_name: Option<&str>) -> EvaluationFailure {
    let csp_blocked = error_name == Some("EvalError")
        || message.contains("Content Security Policy")
        || message.contains("unsafe-eval");
    EvaluationFailure {
        message,
        csp_blocked,
    }
}

async fn retry_csp_failure<F, Fut>(
    result: Result<serde_json::Value, EvaluationFailure>,
    fallback: F,
) -> Result<serde_json::Value, EvaluationFailure>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<serde_json::Value, EvaluationFailure>>,
{
    match result {
        Err(error) if error.csp_blocked => fallback().await,
        result => result,
    }
}

static WEB_PANE_EVAL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static WEB_PANE_EVAL_RESULTS: PendingReplies<Result<serde_json::Value, EvaluationFailure>> =
    OnceLock::new();

fn evaluation_timeout(timeout_ms: Option<u64>) -> Result<Duration, String> {
    let timeout_ms = timeout_ms.unwrap_or(5000);
    if timeout_ms > 25000 {
        return Err("web.eval timeoutMs must be <= 25000 (socket response deadline is 30s); poll again instead".to_string());
    }
    Ok(Duration::from_millis(timeout_ms))
}

fn validate_eval_script(script: &str) -> Result<(), String> {
    if script.len() > WEB_PANE_MAX_TEXT_BYTES {
        return Err("web.eval script exceeds 256 KB".to_string());
    }
    Ok(())
}

async fn evaluation_roundtrip(
    webview: &Webview,
    make_script: impl FnOnce(&str) -> Result<String, String>,
) -> Result<serde_json::Value, EvaluationFailure> {
    let (_pending, receiver) =
        start_evaluation(webview, &WEB_PANE_EVAL_RESULTS, "eval", make_script)
            .map_err(|message| evaluation_failure(message, None))?;
    receiver.await.map_err(|_| {
        evaluation_failure("web.eval failed: result channel closed".to_string(), None)
    })?
}

async fn evaluation_with_timeout<T>(
    timeout: Duration,
    fallback_started: &std::sync::atomic::AtomicBool,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout(timeout, operation).await.map_err(|_| {
        if fallback_started.load(std::sync::atomic::Ordering::Relaxed) {
            "web.eval: no reply after the CSP fallback (syntax error in the script?); the script must be a valid async function body".to_string()
        } else {
            "web.eval failed: timed out".to_string()
        }
    })?
}

async fn evaluate_webpane(
    caller: &Webview,
    app: &AppHandle,
    tab_id: &str,
    timeout_ms: Option<u64>,
    fallback_script: Option<&str>,
    make_script: impl FnOnce(&str) -> Result<String, String>,
) -> Result<serde_json::Value, String> {
    let webview = command_webview(caller, app, tab_id, "web.eval")?;
    let timeout = evaluation_timeout(timeout_ms)?;
    // Queueing and both CSP attempts share one deadline.
    let fallback_started = std::sync::atomic::AtomicBool::new(false);
    evaluation_with_timeout(timeout, &fallback_started, async {
        let _eval_guard = WEB_PANE_EVAL_LOCK.lock().await;
        let result = evaluation_roundtrip(&webview, make_script).await;
        let result = if let Some(script) = fallback_script {
            retry_csp_failure(result, || {
                fallback_started.store(true, std::sync::atomic::Ordering::Relaxed);
                evaluation_roundtrip(&webview, |id| direct_eval_script(id, script))
            })
            .await
        } else {
            result
        };
        result.map_err(|error| error.message)
    })
    .await
}

#[tauri::command]
pub async fn webpane_eval(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    script: String,
    timeout_ms: Option<u64>,
    direct: Option<bool>,
) -> Result<serde_json::Value, String> {
    validate_eval_script(&script)?;
    let direct = direct.unwrap_or(false);
    let value = evaluate_webpane(
        &caller,
        &app,
        &tab_id,
        timeout_ms,
        if direct { None } else { Some(&script) },
        |id| {
            if direct {
                direct_eval_script(id, &script)
            } else {
                eval_script(id, &script)
            }
        },
    )
    .await?;
    Ok(serde_json::json!({ "tabId": tab_id, "value": value }))
}

#[tauri::command]
pub async fn webpane_eval_result(
    caller: Webview,
    request_id: String,
    value: Option<serde_json::Value>,
    error: Option<String>,
    error_name: Option<String>,
) -> Result<(), String> {
    let payload = if let Some(error) = error {
        Err(evaluation_failure(
            format!("web.eval failed: {error}"),
            error_name.as_deref(),
        ))
    } else {
        let value = value.unwrap_or(serde_json::Value::Null);
        if serde_json::to_vec(&value)
            .map_err(|error| error.to_string())?
            .len()
            > WEB_PANE_MAX_READ_BYTES - 160
        {
            Err(evaluation_failure(
                "web.eval failed: result exceeds the 512 KB limit".to_string(),
                None,
            ))
        } else {
            Ok(value)
        }
    };
    complete_evaluation(
        &caller,
        &WEB_PANE_EVAL_RESULTS,
        &request_id,
        "eval",
        payload,
    )
}

fn automation_initialization_script(browser: bool) -> Result<String, String> {
    let config = serde_json::to_string(&serde_json::json!({ "browser": browser }))
        .map_err(|error| error.to_string())?;
    Ok(r##"((config) => {
  if (window.__mycmux) return;
  const state = { generation: Math.floor(Math.random() * 0x100000000), refs: new Map(), lastMutationAt: Date.now(), dialogs: [] };
  Object.defineProperty(window, "__mycmux", { value: state, enumerable: false });
  let nextRef = Math.floor(Math.random() * 1e12);
  const observer = new MutationObserver(records => {
    if (records.some(r => r.type !== "attributes" || r.attributeName !== "data-mycmux-ref"))
      state.lastMutationAt = Date.now();
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  const candidates = 'a[href],button,input:not([type="hidden"]),textarea,select,[contenteditable],[role],h1,h2,h3,h4,h5,h6,img[alt],summary,[tabindex]';
  const visible = el => {
    const style = getComputedStyle(el);
    return el.getClientRects().length > 0 && style.visibility !== "hidden" && Number(style.opacity) !== 0
      && !(el.tagName === "INPUT" && el.type === "hidden");
  };
  const rect = el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const role = el => {
    if (el.getAttribute("role")) return el.getAttribute("role");
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return ({ checkbox: "checkbox", radio: "radio", button: "button",
      submit: "button", reset: "button" })[el.type] || "textbox";
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return "textbox";
    return ({ a: "link", button: "button", textarea: "textbox", select: "combobox",
      img: "img", summary: "button" })[tag] || (/^h[1-6]$/.test(tag) ? "heading" : "generic");
  };
  const name = el => {
    const labelled = (el.getAttribute("aria-labelledby") || "").split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || "").join(" ").trim();
    const label = [...(el.labels || [])].map(n => n.textContent || "").join(" ").trim()
      || [...document.querySelectorAll("label[for]")].filter(n => n.htmlFor === el.id && el.id)
        .map(n => n.textContent || "").join(" ").trim();
    return el.getAttribute("aria-label") || labelled || label || el.getAttribute("title")
      || el.getAttribute("placeholder") || (el.innerText || el.textContent || "").trim().slice(0, 80)
      || el.getAttribute("alt") || "";
  };
  const describe = (el, ref) => {
    const box = rect(el), tag = el.tagName.toLowerCase();
    const node = { ref, role: role(el), name: name(el), tag, rect: box,
      inViewport: box.x < innerWidth && box.y < innerHeight && box.x + box.width > 0 && box.y + box.height > 0 };
    const text = (el.innerText || el.textContent || "").trim();
    if (text) node.text = text;
    if ("value" in el) node.value = String(el.value);
    if (el.href) node.href = el.href;
    if ("checked" in el) node.checked = Boolean(el.checked);
    else if (el.hasAttribute("aria-checked")) node.checked = el.getAttribute("aria-checked") === "true";
    if ("disabled" in el || el.hasAttribute("aria-disabled"))
      node.disabled = Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
    if (/^h[1-6]$/.test(tag)) node.level = Number(tag[1]);
    else if (el.hasAttribute("aria-level")) node.level = Number(el.getAttribute("aria-level"));
    return node;
  };
  const scan = () => {
    for (const el of state.refs.values()) el.removeAttribute("data-mycmux-ref");
    state.refs.clear();
    return [...document.querySelectorAll(candidates)].filter(visible).map(el => {
      const ref = "r" + (++nextRef);
      state.refs.set(ref, el);
      el.setAttribute("data-mycmux-ref", ref);
      return describe(el, ref);
    });
  };
  const resolve = target => {
    let el;
    if (target.ref !== undefined) {
      el = state.refs.get(target.ref);
      if (!el || !el.isConnected) throw new Error("stale ref");
    } else if (target.selector !== undefined) el = document.querySelector(target.selector);
    else el = document.elementFromPoint(target.x, target.y);
    if (!(el instanceof HTMLElement)) throw new Error("target was not found");
    return el;
  };
  const prepare = target => {
    const el = resolve(target);
    if (target.ref !== undefined || target.selector !== undefined)
      el.scrollIntoView({ block: "center", inline: "center" });
    if (el.disabled || el.getAttribute("aria-disabled") === "true") throw new Error("target is disabled");
    return el;
  };
  const targetInfo = el => ({ generation: state.generation, ...(el.getAttribute("data-mycmux-ref") ? { ref: el.getAttribute("data-mycmux-ref") } : {}), rect: rect(el) });
  state.target = ({ target, focus = false, select = false, append = false, editable = false }) => {
    const el = prepare(target);
    if (editable && (el.readOnly
      || (el instanceof HTMLInputElement && !["text","search","email","url","tel","password","number"].includes(el.type))
      || (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)
        && !el.isContentEditable && el.getAttribute("contenteditable") !== "true")))
      throw new Error("target is not a writable text field");
    if (focus) el.focus();
    let appendWithEndKey = false;
    if (append) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        try { el.setSelectionRange(el.value.length, el.value.length); }
        catch (_) { appendWithEndKey = true; }
      }
      else {
        const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    }
    if (select) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
      else {
        const range = document.createRange(); range.selectNodeContents(el);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    }
    return { ...targetInfo(el), ...(appendWithEndKey ? { appendWithEndKey: true } : {}) };
  };
  const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
  const bound = (result, maxBytes) => {
    if (size(result) <= maxBytes) return result;
    result.truncated = true;
    while (result.nodes?.length && size(result) > maxBytes) result.nodes.pop();
    for (const field of ["text", "title", "url"]) {
      if (typeof result[field] !== "string" || size(result) <= maxBytes) continue;
      const chars = [...result[field]];
      let low = 0, high = chars.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        result[field] = chars.slice(0, mid).join("");
        if (size(result) <= maxBytes) low = mid; else high = mid - 1;
      }
      result[field] = chars.slice(0, low).join("");
    }
    if (size(result) > maxBytes) throw new Error("maxBytes is too small for snapshot metadata");
    return result;
  };
  state.snapshot = ({ mode = "ax", maxBytes = 262144 }) => {
    if (!Number.isInteger(maxBytes) || maxBytes < 4096 || maxBytes > 524288)
      throw new Error("web.snapshot maxBytes must be between 4096 and 524288");
    const nodes = scan();
    const result = { url: location.href, title: document.title, truncated: false };
    if (mode === "text") result.text = document.body?.innerText || document.body?.textContent || "";
    else {
      result.viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
      result.nodes = nodes.slice(0, 800);
      result.truncated = nodes.length > 800;
    }
    return bound(result, maxBytes - 160);
  };
  state.find = ({ text, role: wantedRole, selector, exact = false, limit = 20 }) => {
    const nodes = scan().filter(node => {
      if (selector && !state.refs.get(node.ref).matches(selector)) return false;
      if (wantedRole && node.role !== wantedRole) return false;
      if (text !== undefined) {
        const needle = text.toLowerCase();
        return [node.name, node.text || ""].some(s => exact ? s.toLowerCase() === needle : s.toLowerCase().includes(needle));
      }
      return true;
    }).slice(0, limit);
    return { nodes };
  };
  state.click = ({ target, options = {} }) => {
    const clickCount = options.clickCount ?? 1;
    if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3)
      throw new Error("web.click clickCount must be between 1 and 3");
    const el = prepare(target), info = targetInfo(el), box = info.rect;
    const button = ({ left: 0, middle: 1, right: 2 })[options.button || "left"];
    const buttons = ({ 0: 1, 1: 4, 2: 2 })[button];
    const point = { clientX: target.x ?? box.x + box.width / 2, clientY: target.y ?? box.y + box.height / 2 };
    for (let i = 1; i <= clickCount; i++) {
      const init = { bubbles: true, cancelable: true, composed: true, button, detail: i, ...point };
      const pointer = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      el.dispatchEvent(new pointer("pointerdown", { ...init, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      const down = el.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons }));
      if (down) el.focus();
      el.dispatchEvent(new pointer("pointerup", { ...init, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
      el.dispatchEvent(new MouseEvent(button === 0 ? "click" : "auxclick", { ...init, buttons: 0 }));
      if (button === 2) el.dispatchEvent(new MouseEvent("contextmenu", init));
      if (button === 0 && i === 2) el.dispatchEvent(new MouseEvent("dblclick", init));
    }
    return { target: info, trusted: false };
  };
  state.key = ({ key, code, modifiers = [], ref }) => {
    const el = ref ? prepare({ ref }) : document.activeElement || document.body;
    if (ref) el.focus();
    const init = { key, code: code || "", bubbles: true, cancelable: true, composed: true,
      ctrlKey: modifiers.includes("ctrl"), shiftKey: modifiers.includes("shift"),
      altKey: modifiers.includes("alt"), metaKey: modifiers.includes("meta") };
    for (const kind of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(kind, init));
    return { key, trusted: false };
  };
  state.type = ({ target, text, mode = "replace", submit = false }) => {
    const el = prepare(target); el.focus();
    const native = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    if (!native && !el.isContentEditable && el.getAttribute("contenteditable") !== "true")
      throw new Error("target is not editable");
    if (el.readOnly || (el instanceof HTMLInputElement && !["text","search","email","url","tel","password","number"].includes(el.type)))
      throw new Error("target is not a writable text field");
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: text });
    if (!el.dispatchEvent(before)) throw new Error("beforeinput was cancelled");
    if (native) {
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const value = mode === "append" ? el.value + text : text;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    } else {
      const range = document.createRange(); range.selectNodeContents(el);
      if (mode === "append") range.collapse(false);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const previous = el.textContent || "";
      let inserted = false;
      try { inserted = document.execCommand("insertText", false, text); } catch (_) {}
      if (!inserted) {
        el.textContent = mode === "append" ? previous + text : text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      }
    }
    if (submit) state.key({ key: "Enter", code: "Enter" });
    return { target: targetInfo(el), chars: [...text].length, submitted: submit };
  };
  state.scroll = ({ target = {}, deltaX = 0, deltaY = 600 }) => {
    let el = target.ref || target.selector ? prepare(target) : null;
    while (el) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflow + style.overflowX + style.overflowY)
        && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) break;
      el = el.parentElement;
    }
    if (el) { el.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" }); return { scrollX: el.scrollLeft, scrollY: el.scrollTop }; }
    window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  };
  state.upload = ({ target, files, mode = "input" }) => {
    const el = prepare(target), transfer = new DataTransfer();
    for (const file of files) {
      const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: "application/octet-stream" }));
    }
    if (mode === "drop") {
      for (const kind of ["dragenter", "dragover", "drop"])
        el.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    } else {
      if (!(el instanceof HTMLInputElement) || el.type !== "file") throw new Error("target is not a file input");
      if (!el.multiple && files.length > 1) throw new Error("file input does not accept multiple files");
      el.files = transfer.files;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { files: files.map(({ name, size }) => ({ name, size })), mode, trusted: false };
  };
  state.readDialogs = ({ clear = false }) => {
    const dialogs = state.dialogs.slice();
    if (clear) state.dialogs.length = 0;
    return { dialogs };
  };
  if (config.browser) {
    const record = (kind, message) => state.dialogs.push({ kind, message: String(message ?? ""), at: new Date().toISOString() });
    window.alert = message => { record("alert", message); };
    window.confirm = message => { record("confirm", message); return true; };
    window.prompt = (message, value = "") => { record("prompt", message); return String(value); };
  }
})(__CONFIG__);"##.replace("__CONFIG__", &config))
}

fn evaluation_source(
    request_id: &str,
    script: Option<&str>,
    method: Option<&str>,
    parameters: serde_json::Value,
    execution: &str,
) -> Result<String, String> {
    let config = serde_json::to_string(&serde_json::json!({
        "requestId": request_id, "script": script, "method": method,
        "parameters": parameters, "limit": WEB_PANE_MAX_READ_BYTES - 160
    }))
    .map_err(|error| error.to_string())?;
    Ok(format!(
        r#"((config) => {{
  const reply = (value, error, errorName = null) => window.__TAURI_INTERNALS__.invoke("webpane_eval_result",
    {{ requestId: config.requestId, value, error, errorName }}).catch(() => undefined);
  void (async () => {{
    try {{
      const value = {execution};
      const json = JSON.stringify(value === undefined ? null : value);
      if (json === undefined) throw new Error("result is not JSON serializable");
      if (new TextEncoder().encode(json).length > config.limit) throw new Error("result exceeds the 512 KB limit");
      await reply(JSON.parse(json), null);
    }} catch (error) {{ await reply(null, String(error?.message || error), String(error?.name || "")); }}
  }})();
}})({config});"#
    ))
}

fn evaluation_script(
    request_id: &str,
    script: Option<&str>,
    method: Option<&str>,
    parameters: serde_json::Value,
) -> Result<String, String> {
    let execution = if method.is_some() {
        "await window.__mycmux[config.method](config.parameters)"
    } else {
        "await Object.getPrototypeOf(async function(){}).constructor(config.script)()"
    };
    evaluation_source(request_id, script, method, parameters, execution)
}

fn eval_script(request_id: &str, script: &str) -> Result<String, String> {
    validate_eval_script(script)?;
    evaluation_script(request_id, Some(script), None, serde_json::Value::Null)
}

fn direct_eval_script(request_id: &str, script: &str) -> Result<String, String> {
    validate_eval_script(script)?;
    let execution = format!("await (async () => {{\n{script}\n}})()");
    evaluation_source(request_id, None, None, serde_json::Value::Null, &execution)
}

async fn helper_result(
    caller: &Webview,
    app: &AppHandle,
    tab_id: &str,
    make_script: impl FnOnce(&str) -> Result<String, String>,
) -> Result<serde_json::Value, String> {
    let mut value = evaluate_webpane(caller, app, tab_id, None, None, make_script).await?;
    let result = value
        .as_object_mut()
        .ok_or_else(|| "web.eval failed: expected an object".to_string())?;
    result.insert("tabId".to_string(), serde_json::json!(tab_id));
    Ok(value)
}

#[tauri::command]
pub async fn webpane_navigate(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    url: Option<String>,
    action: Option<String>,
) -> Result<serde_json::Value, String> {
    let webview = command_webview(&caller, &app, &tab_id, "web.navigate")?;
    match (url, action.as_deref()) {
        (Some(url), None) => {
            let parsed = url
                .parse::<Url>()
                .map_err(|error| format!("web.navigate invalid URL: {error}"))?;
            let preset = preset_for_label(webview.label())
                .ok_or_else(|| "web.navigate unknown preset".to_string())?;
            if !preset_keeps_url_inside_pane(preset, &parsed) {
                return Err("web.navigate URL is outside the preset's allowed hosts".to_string());
            }
            webview
                .navigate(parsed)
                .map_err(|error| format!("web.navigate failed: {error}"))?;
        }
        (None, Some("reload")) => webview
            .reload()
            .map_err(|error| format!("web.navigate failed: {error}"))?,
        (None, Some("back")) => webview
            .eval("history.back()")
            .map_err(|error| format!("web.navigate failed: {error}"))?,
        (None, Some("forward")) => webview
            .eval("history.forward()")
            .map_err(|error| format!("web.navigate failed: {error}"))?,
        _ => return Err("web.navigate requires url or action back/forward/reload".to_string()),
    }
    Ok(serde_json::json!({ "tabId": tab_id, "accepted": true }))
}

fn validate_snapshot_max_bytes(max_bytes: usize) -> Result<(), String> {
    if !(4096..=WEB_PANE_MAX_READ_BYTES).contains(&max_bytes) {
        return Err("web.snapshot maxBytes must be between 4096 and 524288".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn webpane_snapshot(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    mode: Option<String>,
    max_bytes: Option<usize>,
) -> Result<serde_json::Value, String> {
    let mode = mode.as_deref().unwrap_or("ax");
    if !matches!(mode, "ax" | "text") {
        return Err("web.snapshot mode must be ax or text".to_string());
    }
    let max_bytes = max_bytes.unwrap_or(262144);
    validate_snapshot_max_bytes(max_bytes)?;
    helper_result(&caller, &app, &tab_id, |id| {
        snapshot_script(
            id,
            serde_json::json!({ "mode": mode, "maxBytes": max_bytes }),
        )
    })
    .await
}

#[tauri::command]
pub async fn webpane_find(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    query: serde_json::Value,
) -> Result<serde_json::Value, String> {
    helper_result(&caller, &app, &tab_id, |id| find_script(id, query)).await
}

#[tauri::command]
pub async fn webpane_click(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    target: serde_json::Value,
    options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    helper_result(&caller, &app, &tab_id, |id| click_script(id, serde_json::json!({ "target": target, "options": options.unwrap_or(serde_json::json!({})) }))).await
}

#[tauri::command]
pub async fn webpane_type(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    target: serde_json::Value,
    text: String,
    mode: Option<String>,
    submit: Option<bool>,
) -> Result<serde_json::Value, String> {
    let mode = mode.as_deref().unwrap_or("replace");
    if !matches!(mode, "replace" | "append") {
        return Err("web.type mode must be replace or append".to_string());
    }
    helper_result(&caller, &app, &tab_id, |id| type_script(id, serde_json::json!({ "target": target, "text": text, "mode": mode, "submit": submit.unwrap_or(false) }))).await
}

#[tauri::command]
pub async fn webpane_key(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    key: String,
    code: Option<String>,
    modifiers: Option<Vec<String>>,
    target: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    helper_result(&caller, &app, &tab_id, |id| {
        key_script(
            id,
            serde_json::json!({
                "key": key, "code": code, "modifiers": modifiers.unwrap_or_default(),
                "ref": target.and_then(|target| target.get("ref").cloned())
            }),
        )
    })
    .await
}

#[tauri::command]
pub async fn webpane_scroll(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    target: Option<serde_json::Value>,
    delta_x: Option<f64>,
    delta_y: Option<f64>,
) -> Result<serde_json::Value, String> {
    helper_result(&caller, &app, &tab_id, |id| scroll_script(id, serde_json::json!({
        "target": target.unwrap_or(serde_json::json!({})), "deltaX": delta_x.unwrap_or(0.0), "deltaY": delta_y.unwrap_or(600.0)
    }))).await
}

const WEB_PANE_MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadFile {
    name: String,
    size: u64,
    data: String,
}

fn upload_files(paths: &[String]) -> Result<Vec<UploadFile>, String> {
    if paths.is_empty() {
        return Err("web.upload paths must not be empty".to_string());
    }
    let mut total = 0_u64;
    // Validate the entire selection before reading or sending any file.
    for path in paths {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("web.upload cannot read {path}: {error}"))?;
        if !metadata.is_file() {
            return Err(format!("web.upload path is not a file: {path}"));
        }
        total = total
            .checked_add(metadata.len())
            .ok_or_else(|| "web.upload size overflow".to_string())?;
        if total > WEB_PANE_MAX_UPLOAD_BYTES {
            return Err("web.upload files exceed the 25 MB limit".to_string());
        }
    }
    let mut files = Vec::new();
    total = 0;
    for path in paths {
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|error| format!("web.upload cannot open {path}: {error}"))?
            .take(WEB_PANE_MAX_UPLOAD_BYTES - total + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("web.upload cannot read {path}: {error}"))?;
        total += bytes.len() as u64;
        if total > WEB_PANE_MAX_UPLOAD_BYTES {
            return Err("web.upload files exceed the 25 MB limit".to_string());
        }
        let name = Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "web.upload filename is not valid UTF-8".to_string())?
            .to_string();
        files.push(UploadFile {
            name,
            size: bytes.len() as u64,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    Ok(files)
}

#[tauri::command]
pub async fn webpane_upload(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    target: serde_json::Value,
    paths: Vec<String>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    command_webview(&caller, &app, &tab_id, "web.upload")?;
    let mode = mode.unwrap_or_else(|| "input".to_string());
    if !matches!(mode.as_str(), "input" | "drop") {
        return Err("web.upload mode must be input or drop".to_string());
    }
    let files = tauri::async_runtime::spawn_blocking(move || upload_files(&paths))
        .await
        .map_err(|error| format!("web.upload failed: {error}"))??;
    helper_result(&caller, &app, &tab_id, |id| {
        upload_script(
            id,
            serde_json::json!({ "target": target, "files": files, "mode": mode }),
        )
    })
    .await
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRecord {
    #[serde(skip)]
    tab_id: String,
    url: String,
    path: Option<PathBuf>,
    success: bool,
    finished_at: String,
}
#[derive(Default)]
struct DownloadState {
    records: Vec<DownloadRecord>,
    reserved: HashMap<PathBuf, String>,
}
static WEB_PANE_DOWNLOADS: OnceLock<Mutex<DownloadState>> = OnceLock::new();

fn download_state() -> &'static Mutex<DownloadState> {
    WEB_PANE_DOWNLOADS.get_or_init(|| Mutex::new(DownloadState::default()))
}

fn sanitized_download_name(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut name: String = leaf
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    name = name.trim_matches([' ', '.']).to_string();
    if name.is_empty() {
        name = "download".to_string();
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        name.insert(0, '_');
    }
    while name.len() > 180 {
        name.pop();
    }
    name.truncate(name.trim_end_matches([' ', '.']).len());
    name
}

fn download_reservation_key(path: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

fn reserve_download_path(
    directory: &Path,
    name: &str,
    tab_id: &str,
    state: &mut DownloadState,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("web.downloads cannot create directory: {error}"))?;
    let name = sanitized_download_name(name);
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let extension = Path::new(&name).extension().and_then(|s| s.to_str());
    let mut number = 1_u64;
    loop {
        let filename = if number == 1 {
            name.clone()
        } else if let Some(extension) = extension {
            format!("{stem}-{number}.{extension}")
        } else {
            format!("{stem}-{number}")
        };
        let path = directory.join(filename);
        let key = download_reservation_key(&path);
        if !path.exists() && !state.reserved.contains_key(&key) {
            state.reserved.insert(key, tab_id.to_string());
            return Ok(path);
        }
        number += 1;
    }
}

fn handle_download(tab_id: &str, preset: WebPanePreset, event: DownloadEvent<'_>) -> bool {
    let Ok(mut state) = download_state().lock() else {
        return false;
    };
    match event {
        DownloadEvent::Requested { destination, .. } => {
            let Some(home) = dirs::home_dir() else {
                return false;
            };
            let directory = home
                .join(".mycmux")
                .join("handoff")
                .join("web")
                .join(preset.id)
                .join("downloads");
            let name = destination
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("download");
            match reserve_download_path(&directory, name, tab_id, &mut state) {
                Ok(path) => {
                    *destination = path;
                    true
                }
                Err(error) => {
                    eprintln!("[web-pane] {error}");
                    false
                }
            }
        }
        DownloadEvent::Finished { url, path, success } => {
            if let Some(path) = &path {
                state.reserved.remove(&download_reservation_key(path));
            }
            if open_presets().contains_key(&format!("web-pane-{tab_id}")) {
                state.records.push(DownloadRecord {
                    tab_id: tab_id.to_string(),
                    url: url.to_string(),
                    path,
                    success,
                    finished_at: chrono::Utc::now().to_rfc3339(),
                });
            }
            true
        }
        _ => true,
    }
}

#[tauri::command]
pub async fn webpane_downloads(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
) -> Result<serde_json::Value, String> {
    command_webview(&caller, &app, &tab_id, "web.downloads")?;
    let state = download_state()
        .lock()
        .map_err(|_| "web.downloads lock poisoned".to_string())?;
    let downloads: Vec<_> = state
        .records
        .iter()
        .filter(|record| record.tab_id == tab_id)
        .collect();
    Ok(serde_json::json!({ "tabId": tab_id, "downloads": downloads }))
}

#[tauri::command]
pub async fn webpane_dialogs(
    caller: Webview,
    app: AppHandle,
    tab_id: String,
    clear: Option<bool>,
) -> Result<serde_json::Value, String> {
    helper_result(&caller, &app, &tab_id, |id| {
        dialogs_script(id, serde_json::json!({ "clear": clear.unwrap_or(false) }))
    })
    .await
}

fn snapshot_script(request_id: &str, parameters: serde_json::Value) -> Result<String, String> {
    evaluation_script(request_id, None, Some("snapshot"), parameters)
}

fn find_script(request_id: &str, parameters: serde_json::Value) -> Result<String, String> {
    evaluation_script(request_id, None, Some("find"), parameters)
}

fn click_script(request_id: &str, parameters: serde_json::Value) -> Result<String, String> {
    evaluation_script(request_id, None, Some("click"), parameters)
}

fn type_script(request_id: &str, parameters: serde_json::Value) -> Result<String, String> {
    evaluation_script(request_id, None, Some("type"), parameters)
}

fn key_script(request_id: &str, parameters: serde_json::Value) -> Result<String, String> {
    evaluation_script(request_id, None, Some("key"), parameters)
}

fn scroll_script(request_id: &str, parameters: serde_json::Value) -> Result<String, String> {
    evaluation_script(request_id, None, Some("scroll"), parameters)
}

fn upload_script(request_id: &str, parameters: serde_json::Value) -> Result<String, String> {
    evaluation_script(request_id, None, Some("upload"), parameters)
}

fn dialogs_script(request_id: &str, parameters: serde_json::Value) -> Result<String, String> {
    evaluation_script(request_id, None, Some("readDialogs"), parameters)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn csp_fallback_timeout_explains_the_missing_reply_and_async_body_syntax() {
        let started = std::sync::atomic::AtomicBool::new(false);
        let result: Result<(), String> =
            evaluation_with_timeout(Duration::from_millis(1), &started, async {
                retry_csp_failure(
                    Err(evaluation_failure("blocked".into(), Some("EvalError"))),
                    || async {
                        started.store(true, std::sync::atomic::Ordering::Relaxed);
                        std::future::pending().await
                    },
                )
                .await
                .map(|_| ())
                .map_err(|error| error.message)
            })
            .await;
        assert_eq!(result.unwrap_err(), "web.eval: no reply after the CSP fallback (syntax error in the script?); the script must be a valid async function body");
    }

    #[tokio::test]
    async fn evaluation_timeout_without_csp_keeps_its_existing_message() {
        let started = std::sync::atomic::AtomicBool::new(false);
        let result: Result<(), String> =
            evaluation_with_timeout(Duration::from_millis(1), &started, std::future::pending())
                .await;
        assert_eq!(result.unwrap_err(), "web.eval failed: timed out");
        started.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            evaluation_with_timeout(Duration::from_secs(1), &started, async { Ok(42) })
                .await
                .unwrap(),
            42
        );
        let result: Result<(), String> =
            evaluation_with_timeout(Duration::from_secs(1), &started, async {
                Err("specific reply".to_string())
            })
            .await;
        assert_eq!(result.unwrap_err(), "specific reply");
    }

    #[tokio::test]
    async fn csp_fallback_retries_only_eval_errors_and_csp_messages() {
        for (name, message, retry) in [
            (Some("EvalError"), "blocked", true),
            (
                Some("Error"),
                "Content Security Policy rejected evaluation",
                true,
            ),
            (None, "unsafe-eval is forbidden", true),
            (Some("SyntaxError"), "Unexpected token", false),
            (Some("Error"), "ordinary error mentioning EvalError", false),
        ] {
            let calls = std::cell::Cell::new(0);
            let failure = evaluation_failure(message.to_string(), name);
            let result = retry_csp_failure(Err(failure), || async {
                calls.set(calls.get() + 1);
                Ok(serde_json::json!(42))
            })
            .await;
            assert_eq!(calls.get(), i32::from(retry));
            assert_eq!(result.is_ok(), retry);
        }
        let result = retry_csp_failure(Ok(serde_json::json!(7)), || async {
            panic!("successful evaluation must not run twice");
        })
        .await
        .unwrap();
        assert_eq!(result, 7);
        let result = retry_csp_failure(
            Err(evaluation_failure("blocked".into(), Some("EvalError"))),
            || async { Err(evaluation_failure("fallback failed".into(), None)) },
        )
        .await
        .unwrap_err();
        assert_eq!(result.message, "fallback failed");
    }

    #[test]
    fn eval_script_limits_utf8_bytes_and_embeds_csp_fallback_directly() {
        let at_limit = "\u{1f600}".repeat(65536);
        assert!(validate_eval_script(&at_limit).is_ok());
        assert_eq!(
            validate_eval_script(&(at_limit + "x")).unwrap_err(),
            "web.eval script exceeds 256 KB"
        );
        let source = "return '__CONFIG__ __EXECUTE__ </script>'; // trailing comment";
        let direct = direct_eval_script("request", source).unwrap();
        assert!(direct.contains(&format!("await (async () => {{\n{source}\n}})()")));
        assert!(!direct.contains(".constructor("));
        assert!(eval_script("request", "return 42")
            .unwrap()
            .contains(".constructor(config.script)"));
        assert!(!snapshot_script("request", serde_json::json!({}))
            .unwrap()
            .contains(".constructor("));
    }

    #[test]
    fn snapshot_budget_rejects_below_4096_and_accepts_the_boundary() {
        assert!(validate_snapshot_max_bytes(4095).is_err());
        assert!(validate_snapshot_max_bytes(4096).is_ok());
        assert!(validate_snapshot_max_bytes(524288).is_ok());
        assert!(validate_snapshot_max_bytes(524289).is_err());
    }

    #[test]
    fn download_sanitize_handles_reserved_extensions_and_truncated_suffixes() {
        for name in ["COM1.txt", "LPT1.txt", "CON.x", "AUX", "NUL", "PRN"] {
            assert_eq!(sanitized_download_name(name), format!("_{name}"));
        }
        for suffix in [".txt", " suffix"] {
            assert_eq!(
                sanitized_download_name(&("a".repeat(179) + suffix)),
                "a".repeat(179)
            );
        }
        let long_reserved = sanitized_download_name(&("CON.".to_string() + &"x".repeat(200)));
        assert!(long_reserved.starts_with("_CON."));
        assert!(long_reserved.len() <= 180);
    }

    #[test]
    fn download_reservations_fold_case_on_windows() {
        let directory =
            std::env::temp_dir().join(format!("mycmux-case-download-{}", uuid::Uuid::new_v4()));
        let mut state = DownloadState::default();
        reserve_download_path(&directory, "Report.TXT", "a", &mut state).unwrap();
        let second = reserve_download_path(&directory, "report.txt", "b", &mut state).unwrap();
        assert_eq!(
            second,
            directory.join(if cfg!(target_os = "windows") {
                "report-2.txt"
            } else {
                "report.txt"
            })
        );
        assert_eq!(state.reserved.len(), 2);
    }

    #[test]
    fn evaluation_timeout_stays_below_socket_response_deadline() {
        assert_eq!(
            evaluation_timeout(None).unwrap(),
            Duration::from_millis(5000)
        );
        assert_eq!(
            evaluation_timeout(Some(25000)).unwrap(),
            Duration::from_millis(25000)
        );
        assert_eq!(evaluation_timeout(Some(25001)).unwrap_err(), "web.eval timeoutMs must be <= 25000 (socket response deadline is 30s); poll again instead");
    }

    #[test]
    fn browser_url_policy_and_profile_do_not_change_service_policies() {
        let browser = preset_by_id("browser").unwrap();
        assert_eq!(browser.profile_dir, "ai");
        assert!(browser.reader.is_none() && browser.composer.is_none());
        assert!(browser.signed_out_patterns.is_empty());
        assert_eq!(
            initial_webpane_url(browser, None).unwrap().as_str(),
            "about:blank"
        );
        for url in [
            "https://example.com/x",
            "http://localhost:8000/a",
            "http://127.0.0.1:1/",
        ] {
            assert!(
                preset_keeps_url_inside_pane(browser, &url.parse().unwrap()),
                "{url}"
            );
        }
        for url in [
            "http://example.com/",
            "file:///C:/x",
            "http://localhost.evil/",
            "about:blank",
            "data:text/html,x",
        ] {
            assert!(
                !preset_keeps_url_inside_pane(browser, &url.parse().unwrap()),
                "{url}"
            );
        }
        for id in ["chatgpt", "gemini", "grok", "claude", "notebooklm"] {
            let preset = preset_by_id(id).unwrap();
            assert!(preset_keeps_url_inside_pane(
                preset,
                &preset.url.parse().unwrap()
            ));
            assert!(preset_keeps_url_inside_pane(
                preset,
                &"https://accounts.google.com/login".parse().unwrap()
            ));
            assert!(!preset_keeps_url_inside_pane(
                preset,
                &"https://example.com/".parse().unwrap()
            ));
            assert!(!automation_initialization_script(false)
                .unwrap()
                .contains("\"browser\":true"));
        }
    }

    #[test]
    fn automation_scripts_json_encode_every_parameter_and_request() {
        let special = "quote ' \" </script>\n\u{1f600}";
        let parameters = serde_json::json!({ "text": special, "selector": special });
        for make in [
            snapshot_script,
            find_script,
            click_script,
            type_script,
            key_script,
            scroll_script,
            upload_script,
            dialogs_script,
        ] {
            let script = make(special, parameters.clone()).unwrap();
            assert!(script.contains(&serde_json::to_string(special).unwrap()));
            assert!(script.contains(&serde_json::to_string(&parameters).unwrap()));
            assert!(script.contains("webpane_eval_result"));
        }
        let script = eval_script(special, special).unwrap();
        assert!(script.contains(&serde_json::to_string(special).unwrap()));
    }

    #[test]
    fn upload_validates_missing_directories_total_size_and_encodes_bytes() {
        let directory =
            std::env::temp_dir().join(format!("mycmux-upload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        assert!(upload_files(&[]).is_err());
        assert!(upload_files(&[directory.join("missing").to_string_lossy().into_owned()]).is_err());
        assert!(upload_files(&[directory.to_string_lossy().into_owned()])
            .unwrap_err()
            .contains("not a file"));
        let small = directory.join("input.txt");
        std::fs::write(&small, b"hello").unwrap();
        let files = upload_files(&[small.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(files[0].name, "input.txt");
        assert_eq!(files[0].size, 5);
        assert_eq!(files[0].data, "aGVsbG8=");
        let big = directory.join("big.bin");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(WEB_PANE_MAX_UPLOAD_BYTES + 1)
            .unwrap();
        assert!(upload_files(&[big.to_string_lossy().into_owned()])
            .unwrap_err()
            .contains("25 MB"));
        std::fs::File::create(&big)
            .unwrap()
            .set_len(WEB_PANE_MAX_UPLOAD_BYTES)
            .unwrap();
        assert!(upload_files(&[
            big.to_string_lossy().into_owned(),
            small.to_string_lossy().into_owned()
        ])
        .unwrap_err()
        .contains("25 MB"));
    }

    #[test]
    fn download_names_are_sanitized_and_reservations_prevent_collisions() {
        assert_eq!(
            sanitized_download_name("../bad:name?.txt "),
            "bad_name_.txt"
        );
        assert_eq!(sanitized_download_name("C:\\path\\CON.txt"), "_CON.txt");
        assert_eq!(sanitized_download_name("..."), "download");
        assert!(sanitized_download_name(&"\u{1f600}".repeat(100)).len() <= 180);
        let directory =
            std::env::temp_dir().join(format!("mycmux-download-{}", uuid::Uuid::new_v4()));
        let mut state = DownloadState::default();
        let first = reserve_download_path(&directory, "../report.txt", "a", &mut state).unwrap();
        let second = reserve_download_path(&directory, "report.txt", "b", &mut state).unwrap();
        assert_eq!(first, directory.join("report.txt"));
        assert_eq!(second, directory.join("report-2.txt"));
        std::fs::write(directory.join("report-3.txt"), b"existing").unwrap();
        assert_eq!(
            reserve_download_path(&directory, "report.txt", "a", &mut state).unwrap(),
            directory.join("report-4.txt")
        );
    }

    #[test]
    fn generated_automation_scripts_execute_against_a_real_dom_in_node() {
        use std::io::Write;
        use std::process::Stdio;
        let scripts = serde_json::json!({
            "init": automation_initialization_script(true).unwrap(),
            "serviceInit": automation_initialization_script(false).unwrap(),
            "snapshot": snapshot_script("snap", serde_json::json!({})).unwrap(),
            "click": click_script("click", serde_json::json!({"target": {"selector": "#counter"}})).unwrap(),
            "type": type_script("type", serde_json::json!({"target": {"selector": "#text"}, "text": "quote ' </script>\n\u{1f600}"})).unwrap(),
            "textarea": type_script("textarea", serde_json::json!({"target": {"selector": "#multiline"}, "text": "line one\nline two\n\u{1f600}"})).unwrap(),
            "editable": type_script("editable", serde_json::json!({"target": {"selector": "#edit"}, "text": "content\nnext\n\u{1f600}", "submit": true})).unwrap(),
            "find": find_script("find", serde_json::json!({"text": "Count", "exact": true})).unwrap(),
            "bounded": snapshot_script("bounded", serde_json::json!({"mode": "text", "maxBytes": 4096})).unwrap(),
            "undefined": eval_script("undefined", "await Promise.resolve();").unwrap(),
            "exception": eval_script("exception", "throw new Error('fixture failure')").unwrap(),
            "oversized": eval_script("oversized", "return 'x'.repeat(524288)").unwrap(),
            "dialogs": dialogs_script("dialogs", serde_json::json!({"clear": true})).unwrap(),
            "upload": upload_script("upload", serde_json::json!({"target":{"selector":"#file"}, "files":[{"name":"fixture.txt","size":5,"data":"aGVsbG8="}]})).unwrap(),
            "drop": upload_script("drop", serde_json::json!({"target":{"selector":"#drop"}, "mode":"drop", "files":[{"name":"fixture.txt","size":5,"data":"aGVsbG8="}]})).unwrap(),
            "csp": eval_script("csp", "return 42").unwrap(),
            "direct": direct_eval_script("direct", "return {value:42,marker:'__CONFIG__ __EXECUTE__'}; // comment").unwrap(),
            "syntax": eval_script("syntax", "return {").unwrap(),
        });
        let fixture = r##"
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const scripts = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const dom = new JSDOM('<h2>Heading</h2><button id="counter">Count</button><label for="text">Your text</label><input id="text"><textarea id="multiline"></textarea><a href="/next">Next</a><div id="edit" contenteditable="true"></div><input type="hidden" id="hidden"><input id="email" type="email" value="a@b.test"><input id="number" type="number" value="12"><input id="file" type="file"><div id="drop"></div><p id="long"></p>', { url: "https://example.com/", runScripts: "outside-only" });
const w = dom.window;
w.TextEncoder = TextEncoder;
w.Math.random = () => 0.25;
w.HTMLElement.prototype.getClientRects = function() { return [this.getBoundingClientRect()]; };
w.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 1, y: 2, width: 100, height: 20 });
let scrolls = 0;
w.HTMLElement.prototype.scrollIntoView = function() { scrolls++; };
w.document.elementFromPoint = () => w.document.querySelector("#counter");
const computed = w.getComputedStyle.bind(w);
w.getComputedStyle = el => { const s = computed(el); return { visibility: s.visibility, opacity: s.opacity || "1" }; };
let reply, clicks = 0, trusted, inputEvents = [], keys = [];
const uploadEvents = [], dropEvents = [];
const fileInput = w.document.querySelector("#file");
if (!w.DataTransfer) {
  w.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  };
  let files = [];
  Object.defineProperty(fileInput, "files", { get: () => files, set: value => { files = value; } });
}
if (!w.DragEvent) w.DragEvent = class extends w.Event {
  constructor(type, init) { super(type, init); this.dataTransfer = init.dataTransfer; }
};
for (const type of ["input", "change"]) fileInput.addEventListener(type, () => uploadEvents.push(type));
for (const type of ["dragenter", "dragover", "drop"]) w.document.querySelector("#drop").addEventListener(type,
  event => dropEvents.push({ type: event.type, files: Array.from(event.dataTransfer.files, f => ({ name: f.name, size: f.size })) }));
w.__TAURI_INTERNALS__ = { invoke: async (command, payload) => { assert.equal(command, "webpane_eval_result"); reply = payload; } };
w.document.querySelector("#counter").addEventListener("click", event => { clicks++; trusted = event.isTrusted; });
w.document.querySelector("#text").addEventListener("input", event => inputEvents.push(event.data));
w.document.querySelector("#edit").addEventListener("keydown", event => keys.push(event.key));
const run = async script => { reply = undefined; w.eval(script); await new Promise(resolve => setImmediate(resolve)); assert.ok(reply); return reply; };
(async () => {
  w.eval(scripts.init);
  const generation = w.__mycmux.generation;
  assert.equal(generation, 0x40000000);
  w.Math.random = () => 0.75;
  w.eval(scripts.init);
  assert.equal(w.__mycmux.generation, generation);
  let result = await run(scripts.snapshot);
  assert.equal(result.requestId, "snap");
  assert.equal(result.error, null);
  const nodes = result.value.nodes;
  assert.ok(nodes.some(n => n.role === "heading" && n.level === 2));
  assert.ok(nodes.some(n => n.role === "link" && n.name === "Next"));
  const input = nodes.find(n => n.tag === "input");
  assert.equal(input.name, "Your text");
  assert.match(input.ref, /^r\d+$/);
  assert.equal(w.document.querySelector("#text").getAttribute("data-mycmux-ref"), input.ref);
  w.location.hash = "#same-document";
  assert.equal(w.__mycmux.target({target:{ref:input.ref}}).generation, generation);
  result = await run(scripts.click);
  assert.equal(result.error, null); assert.equal(clicks, 1); assert.equal(trusted, false);
  const scrollsBeforePoint = scrolls;
  w.__mycmux.target({ target: { x: 10, y: 10 } });
  assert.equal(scrolls, scrollsBeforePoint);
  assert.throws(() => w.__mycmux.target({ target: { selector: "#hidden" }, editable: true }), /not a writable text field/);
  result = await run(scripts.type);
  assert.equal(result.error, null);
  assert.equal(w.document.querySelector("#text").value, "quote ' </script>\u{1f600}");
  assert.equal(inputEvents[0], "quote ' </script>\n\u{1f600}");
  result = await run(scripts.textarea);
  assert.equal(result.error, null);
  assert.equal(w.document.querySelector("#multiline").value, "line one\nline two\n\u{1f600}");
  assert.equal(inputEvents.length, 1);
  result = await run(scripts.editable);
  assert.equal(result.error, null);
  assert.equal(w.document.querySelector("#edit").textContent, "content\nnext\n\u{1f600}");
  assert.deepEqual(keys, ["Enter"]);
  for (const [id, text, expected] of [["email", ".more", "a@b.test.more"], ["number", "3", "123"]]) {
    const target = {selector: "#" + id};
    assert.equal(w.__mycmux.target({target, focus:true, append:true, editable:true}).appendWithEndKey, true);
    w.__mycmux.type({target, text, mode:"append"});
    assert.equal(w.document.getElementById(id).value, expected);
  }
  for (const clickCount of [0, 4, -1, 1.5]) {
    assert.throws(() => w.__mycmux.click({target:{selector:"#counter"}, options:{clickCount}}), /between 1 and 3/);
  }
  assert.equal(clicks, 1);
  w.__mycmux.click({target:{selector:"#counter"}, options:{clickCount:3}});
  assert.equal(clicks, 4);
  result = await run(scripts.upload);
  assert.equal(result.error, null);
  assert.deepEqual(uploadEvents, ["input", "change"]);
  assert.equal(fileInput.files[0].name, "fixture.txt");
  assert.equal(fileInput.files[0].size, 5);
  const contents = await new Promise((resolve, reject) => {
    const reader = new w.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject;
    reader.readAsText(fileInput.files[0]);
  });
  assert.equal(contents, "hello");
  result = await run(scripts.drop);
  assert.equal(result.error, null);
  assert.deepEqual(dropEvents, ["dragenter", "dragover", "drop"].map(type => ({type,files:[{name:"fixture.txt",size:5}]})));
  assert.throws(() => w.__mycmux.snapshot({maxBytes:4095}), /between 4096 and 524288/);
  result = await run(scripts.find);
  assert.equal(result.value.nodes.length, 1);
  assert.equal(result.value.nodes[0].name, "Count");
  assert.throws(() => w.__mycmux.target({target: {ref: input.ref}}), /stale ref/);
  w.document.querySelector("#long").textContent = "\u{1f600}".repeat(1000);
  result = await run(scripts.bounded);
  assert.equal(result.value.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 4096);
  w.document.title = "t".repeat(10000);
  dom.reconfigure({url:"https://example.com/" + "u".repeat(10000)});
  assert.ok(Buffer.byteLength(JSON.stringify(w.__mycmux.snapshot({maxBytes:4096}))) <= 4096);
  const asyncPrototype = w.eval("Object.getPrototypeOf(async function(){})");
  const constructorDescriptor = Object.getOwnPropertyDescriptor(asyncPrototype, "constructor");
  Object.defineProperty(asyncPrototype, "constructor", {
    ...constructorDescriptor, value: function() { throw new w.EvalError("blocked by policy"); }
  });
  result = await run(scripts.csp);
  assert.equal(result.errorName, "EvalError");
  result = await run(scripts.direct);
  assert.equal(result.error, null);
  assert.equal(result.value.value, 42);
  assert.equal(result.value.marker, "__CONFIG__ __EXECUTE__");
  assert.equal((await run(scripts.snapshot)).error, null);
  Object.defineProperty(asyncPrototype, "constructor", constructorDescriptor);
  assert.equal((await run(scripts.syntax)).errorName, "SyntaxError");
  assert.equal((await run(scripts.undefined)).value, null);
  assert.match((await run(scripts.exception)).error, /fixture failure/);
  assert.match((await run(scripts.oversized)).error, /512 KB/);
  w.alert("record me");
  assert.equal((await run(scripts.dialogs)).value.dialogs[0].message, "record me");
  assert.equal((await run(scripts.dialogs)).value.dialogs.length, 0);
  dom.window.close();
  const service = new JSDOM("", {runScripts: "outside-only"});
  const nativeAlert = service.window.alert;
  service.window.eval(scripts.serviceInit);
  assert.equal(service.window.alert, nativeAlert);
  service.window.close();
  const fresh = new JSDOM("", { runScripts: "outside-only" });
  fresh.window.Math.random = () => 0.75;
  fresh.window.eval(scripts.init);
  assert.equal(fresh.window.__mycmux.generation, 0xc0000000);
  assert.notEqual(fresh.window.__mycmux.generation, generation);
  assert.equal(fresh.window.confirm("confirm"), true);
  assert.equal(fresh.window.prompt("prompt", "default"), "default");
  assert.equal(fresh.window.__mycmux.dialogs.length, 2);
  fresh.window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
"##;
        let mut child = std::process::Command::new("node")
            .arg("-e")
            .arg(fixture)
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(serde_json::to_string(&scripts).unwrap().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn readers_match_measured_services_and_scripts_include_selectors_and_request() {
        for id in ["chatgpt", "gemini", "grok"] {
            let preset = preset_by_id(id).unwrap();
            let reader = preset.reader.unwrap();
            let script = read_script(preset, "read-request-123").unwrap();
            for selector in [
                reader.assistant,
                reader.user,
                reader.generating,
                reader.composer,
            ] {
                assert!(script.contains(&serde_json::to_string(selector).unwrap()));
            }
            assert!(script.contains("read-request-123"));
            assert!(script.contains("webpane_read_result"));
            assert!(script.contains("524288"));
        }
        for id in ["claude", "notebooklm"] {
            let preset = preset_by_id(id).unwrap();
            assert!(preset.reader.is_none());
            assert!(read_script(preset, "request")
                .unwrap_err()
                .contains("no reader"));
        }
    }

    #[test]
    fn reader_script_extracts_document_order_visibility_links_and_bounds_utf8_json() {
        let script = read_script(preset_by_id("chatgpt").unwrap(), "read-fixture").unwrap();
        let fixture = r#"
const assert = require("node:assert/strict");
let reply;
global.window = { __TAURI_INTERNALS__: { invoke: (command, payload) => {
  assert.equal(command, "webpane_read_result"); reply = payload; return Promise.resolve();
}}};
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/c/fixture" };
let nodes = [], stops = [], composer = true;
global.document = {
  title: "Fixture",
  querySelectorAll: selector => selector.includes("stop-button") ? stops : nodes,
  querySelector: () => composer ? {} : null,
};
const node = (role, text, links = []) => ({
  innerText: text, matches: selector => selector.includes(role),
  querySelectorAll: () => links.map(href => ({ href })),
});
const run = () => { SCRIPT };
nodes = [node("user", "question"), node("assistant", "old"),
         node("user", "next"), node("assistant", "answer", ["https://example.com/source"])];
stops = [{ offsetParent: null, getClientRects: () => [1] }];
run();
assert.equal(reply.requestId, "read-fixture");
assert.deepEqual(reply.result.turns.map(t => t.role), ["user", "assistant", "user", "assistant"]);
assert.equal(reply.result.lastAssistant, "answer");
assert.deepEqual(reply.result.lastAssistantLinks, ["https://example.com/source"]);
assert.equal(reply.result.generating, true);
assert.equal(reply.result.composerPresent, true);
assert.equal(reply.result.truncated, false);
stops = [{ offsetParent: null, getClientRects: () => [] }];
composer = false;
nodes = [];
run();
assert.equal(reply.result.generating, false);
assert.equal(reply.result.composerPresent, false);
assert.deepEqual(reply.result.turns, []);
assert.equal(reply.result.lastAssistant, "");
nodes = [node("user", "\u65e5".repeat(200000)), node("assistant", "latest")];
run();
assert.equal(reply.result.truncated, true);
assert.deepEqual(reply.result.turns, [{ role: "assistant", text: "latest" }]);
assert.equal(reply.result.chars, 6);
nodes = [node("assistant", "\u{1f600}".repeat(200000))];
run();
assert.equal(reply.result.truncated, true);
assert.ok(Buffer.byteLength(JSON.stringify(reply.result), "utf8") <= 512 * 1024 - 128);
assert.ok(reply.result.lastAssistant.length > 0);
assert.ok(!/[\uD800-\uDBFF]$/.test(reply.result.lastAssistant));
location.hostname = "chatgpt.com.evil.example";
run();
assert.equal(reply.result, null);
assert.match(reply.error, /host changed/);
"#;
        let output = std::process::Command::new("node")
            .arg("-e")
            .arg(fixture.replace("SCRIPT", &script))
            .output()
            .expect("Node is required by the frontend test toolchain");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn initial_url_must_stay_inside_the_preset_allowed_hosts() {
        let preset = preset_by_id("chatgpt").unwrap();
        assert_eq!(
            initial_webpane_url(preset, None).unwrap().as_str(),
            preset.url
        );
        assert_eq!(
            initial_webpane_url(preset, Some("https://chatgpt.com/c/x"))
                .unwrap()
                .as_str(),
            "https://chatgpt.com/c/x"
        );
        assert!(
            initial_webpane_url(preset, Some("https://gemini.google.com/"))
                .unwrap_err()
                .starts_with("web pane url is outside the preset's allowed hosts:")
        );
        assert!(initial_webpane_url(preset, Some("https://chatgpt.com.evil.example/")).is_err());
    }

    #[test]
    fn grok_uses_the_measured_tiptap_composer_and_submit_button() {
        let composer = preset_by_id("grok").unwrap().composer.unwrap();
        assert_eq!(
            composer.selector,
            r#"div.tiptap[role="textbox"], [data-testid="chat-input"] [role="textbox"]"#
        );
        assert_eq!(
            composer.submit_selector,
            r#"[data-testid="chat-submit"], form button[type="submit"]"#
        );
    }

    #[test]
    fn gemini_submit_matches_the_japanese_ui_and_push_polls_for_the_button() {
        // 2026-09-07 test machine: `web.push --send` on a Japanese Gemini pane
        // failed with "submit button was not found" -- the button is
        // `プロンプトを送信`, and it is rendered after the input event.
        let composer = preset_by_id("gemini").unwrap().composer.unwrap();
        assert!(composer.submit_selector.contains("プロンプトを送信"));
        assert!(composer.submit_selector.contains("Send"));
        let script =
            composer_push_script(preset_by_id("gemini").unwrap(), "req", Some("hi"), true).unwrap();
        assert!(script.contains("trySubmit"));
        assert!(script.contains("attempts < 30"));
    }

    #[test]
    fn preset_registry_is_generic_and_resolves_every_service() {
        assert_eq!(WEB_PANE_PRESETS.len(), 6);
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
        let script =
            composer_push_script(chatgpt(), "push-result", Some("draft only"), false).unwrap();
        assert!(script.contains("#prompt-textarea"));
        assert!(script.contains("InputEvent"));
        assert!(!script.contains("submitButton.click()"));
    }

    #[test]
    fn composer_push_submits_only_when_explicitly_requested() {
        let draft = composer_push_script(chatgpt(), "push-result", Some("draft"), false).unwrap();
        let submitted = composer_push_script(chatgpt(), "push-result", Some("send"), true).unwrap();
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
        let error =
            composer_push_script(notebooklm, "push-result", Some("hello"), false).unwrap_err();
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
        let error =
            composer_push_script(chatgpt(), "push-result", Some(&oversized), false).unwrap_err();
        assert!(error.contains("exceeds"));
        assert!(error.contains(&WEB_PANE_MAX_TEXT_BYTES.to_string()));
    }

    #[test]
    fn composer_push_requires_text_unless_submit_is_requested() {
        assert!(composer_push_script(chatgpt(), "push-result", None, false).is_err());
        assert!(composer_push_script(chatgpt(), "push-result", None, true).is_ok());
    }
}
