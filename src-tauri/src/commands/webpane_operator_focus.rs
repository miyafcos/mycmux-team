use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Listener, Manager, Url};

use super::input_proof::{authenticates, fresh, is_hex, new_key, Sequences};

pub(super) const REQUEST_HOST: &str = "mycmux-operator-focus.invalid";
pub(super) const REQUEST_EVENT: &str = "mycmux:web-pane-operator-focus";
const ACCEPTED_EVENT: &str = "mycmux:web-pane-operator-focus-accepted";
const ACK_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_INTERVAL: Duration = Duration::from_millis(500);
const REFUSAL_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Default)]
pub(super) struct AutomationTouches(HashSet<String>);

impl AutomationTouches {
    pub(super) fn mark(&mut self, label: &str) {
        self.0.insert(label.to_owned());
    }

    pub(super) fn record_command(&mut self, label: &str, automation: Option<bool>) {
        if automation.unwrap_or(true) {
            self.mark(label);
        }
    }

    fn contains(&self, label: &str) -> bool {
        self.0.contains(label)
    }
}

pub(super) fn automation_touches() -> MutexGuard<'static, AutomationTouches> {
    static TOUCHED: OnceLock<Mutex<AutomationTouches>> = OnceLock::new();
    TOUCHED.get_or_init(Mutex::default).lock().unwrap_or_else(|error| error.into_inner())
}

pub(super) fn operator_focus_decision(
    gate: &mut OperatorFocusGate,
    url: &Url,
    preset: &str,
    label: &str,
    now_ms: u64,
    now: Instant,
    touches: &AutomationTouches,
) -> OperatorFocusDecision {
    gate.consume(url, preset, now_ms, now, || touches.contains(label))
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum OperatorFocusDecision {
    Discard,
    Focus(String),
    AutomationRefused,
}

pub(super) struct OperatorFocusGate {
    key: String,
    sequences: Sequences,
    last_request: Option<Instant>,
    last_refusal: Option<Instant>,
}

impl OperatorFocusGate {
    pub(super) fn new() -> Self {
        Self::with_key(new_key())
    }

    fn with_key(key: String) -> Self {
        Self { key, sequences: Sequences::default(), last_request: None, last_refusal: None }
    }

    pub(super) fn script(&self) -> String {
        include_str!("webpane_operator_focus.js")
            .replace("__MYCMUX_OPERATOR_FOCUS_KEY__", &self.key)
            .replace("__MYCMUX_HMAC_SHA256__", include_str!("webpane_hmac.js").trim())
    }

    pub(super) fn consume(
        &mut self,
        url: &Url,
        preset: &str,
        now_ms: u64,
        now: Instant,
        is_automated: impl FnOnce() -> bool,
    ) -> OperatorFocusDecision {
        use OperatorFocusDecision::{AutomationRefused, Discard, Focus};
        let Some(request) = ClickRequest::from_url(url) else { return Discard };
        let ClickRequest { document, sequence, pressed, mac, origin, tab } = request;
        let message = format!("{document}\n{sequence}\n{pressed}\n{origin}\n{tab}");
        if !authenticates(&self.key, &message, mac) {
            return Discard;
        }
        if !self.sequences.consume(document, sequence, pressed, |previous| {
            sequence > previous
        }) {
            return Discard;
        }
        if !fresh(pressed, now_ms) || !allowed_origin(&origin) || preset != "browser" {
            return Discard;
        }
        if self.last_request.is_some_and(|last| now.saturating_duration_since(last) < REQUEST_INTERVAL) {
            return Discard;
        }
        self.last_request = Some(now);
        if is_automated() {
            if self.last_refusal.is_some_and(|last| now.saturating_duration_since(last) < REFUSAL_INTERVAL) {
                return Discard;
            }
            self.last_refusal = Some(now);
            return AutomationRefused;
        }
        Focus(tab)
    }

    #[cfg(test)]
    fn document_count(&self) -> usize {
        self.sequences.len()
    }
}

#[derive(Default)]
struct PendingFocusRequests(HashMap<String, (String, Instant)>);

impl PendingFocusRequests {
    fn prune(&mut self, now: Instant) {
        self.0.retain(|_, (_, deadline)| now < *deadline);
    }

    fn remember(&mut self, owner: &str, now: Instant) -> String {
        self.prune(now);
        loop {
            let id = hex::encode(rand::random::<[u8; 16]>());
            if let std::collections::hash_map::Entry::Vacant(entry) = self.0.entry(id.clone()) {
                entry.insert((owner.to_owned(), now + ACK_TIMEOUT));
                return id;
            }
        }
    }

    fn consume(&mut self, id: Option<&str>, now: Instant) -> Option<String> {
        self.prune(now);
        let id = id.filter(|id| is_hex(id, 32))?;
        self.0.remove(id).map(|(owner, _)| owner)
    }
}

fn pending_focus_requests() -> MutexGuard<'static, PendingFocusRequests> {
    static PENDING: OnceLock<Mutex<PendingFocusRequests>> = OnceLock::new();
    PENDING.get_or_init(Mutex::default).lock().unwrap_or_else(|error| error.into_inner())
}

pub(super) fn emit_request(app: &AppHandle, owner: String, tab_id: String, decision: OperatorFocusDecision) {
    let (payload, request_id) = match decision {
        OperatorFocusDecision::Focus(target) => {
            let request_id = pending_focus_requests().remember(&owner, Instant::now());
            let payload = serde_json::json!({
                "tabId": tab_id, "targetTabId": target, "requestId": request_id,
            });
            (payload, Some(request_id))
        }
        OperatorFocusDecision::AutomationRefused => {
            (serde_json::json!({ "tabId": tab_id, "refused": "automation" }), None)
        }
        OperatorFocusDecision::Discard => return,
    };
    let target = tauri::EventTarget::Webview { label: owner };
    if app.emit_to(target, REQUEST_EVENT, payload).is_err() {
        if let Some(id) = request_id {
            pending_focus_requests().0.remove(&id);
        }
    }
}

pub(super) fn listen_for_acceptance(app: &AppHandle) {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Accepted {
        request_id: String,
    }
    let app_handle = app.clone();
    app.listen_any(ACCEPTED_EVENT, move |event| {
        let accepted = serde_json::from_str::<Accepted>(event.payload()).ok();
        let id = accepted.as_ref().map(|accepted| accepted.request_id.as_str());
        let label = pending_focus_requests().consume(id, Instant::now());
        if let Some(primary) = label.and_then(|label| app_handle.get_webview(&label)) {
            let _ = primary.set_focus();
        }
    });
}

struct ClickRequest<'a> {
    document: &'a str,
    sequence: u64,
    pressed: u64,
    mac: &'a str,
    origin: String,
    tab: String,
}

impl<'a> ClickRequest<'a> {
    fn from_url(url: &'a Url) -> Option<Self> {
        if url.host_str() != Some(REQUEST_HOST)
            || url.scheme() != "https"
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.as_str().len() > 1024
        {
            return None;
        }
        let mut path = url.path_segments()?;
        let document = path.next()?;
        let sequence = canonical_number(path.next()?)?;
        let pressed = canonical_number(path.next()?)?;
        let mac = path.next()?;
        if path.next().is_some() || !is_hex(document, 32) || sequence == 0 || !is_hex(mac, 64) {
            return None;
        }
        let mut query = url.query_pairs();
        let (origin_name, origin) = query.next()?;
        let (tab_name, tab) = query.next()?;
        if query.next().is_some() || origin_name != "origin" || tab_name != "tab"
            || origin.is_empty() || origin.len() > 256
            || !origin.bytes().all(|byte| byte.is_ascii_graphic())
            || tab.is_empty() || tab.len() > 128
            || !tab.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
        {
            return None;
        }
        Some(Self { document, sequence, pressed, mac, origin: origin.into_owned(), tab: tab.into_owned() })
    }
}

fn canonical_number(text: &str) -> Option<u64> {
    let value = text.parse::<u64>().ok()?;
    (value.to_string() == text).then_some(value)
}

fn allowed_origin(origin: &str) -> bool {
    Url::parse(origin).is_ok_and(|url| {
        url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            && url.origin().ascii_serialization() == origin
    })
}

#[cfg(test)]
#[path = "webpane_operator_focus_tests.rs"]
mod tests;
