use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ResetTickets {
    pub available: u32,
    pub expires_at: Option<String>,
    pub usable_now: bool,
    pub blocked_reason: Option<ResetTicketBlockedReason>,
    pub clears: Vec<String>,
    pub moves_weekly_reset: bool,
    pub requires_limit: bool,
    pub title: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetTicketBlockedReason {
    RequiresLimit,
    Paused,
    Cooldown,
    BlockedByOtherLimit,
    NotOffered,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetTicketOutcomeKind {
    Reset,
    AlreadyUsed,
    OfferChanged,
    NothingToReset,
    NoTicket,
    Cooldown,
    RateLimited,
    AuthError,
    TokenStale,
    OwnerMismatch,
    Unconfirmed,
    Unavailable,
    Busy,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ResetTicketOutcome {
    pub kind: ResetTicketOutcomeKind,
    pub resets_left: Option<u32>,
    pub weekly_resets_at: Option<String>,
    pub retry_of_unconfirmed: bool,
    /// For the `reset_ticket_use` log line only; the page never sees it.
    #[serde(skip)]
    pub trace: ResetTrace,
}

impl ResetTicketOutcome {
    pub fn new(kind: ResetTicketOutcomeKind) -> Self {
        Self {
            kind,
            resets_left: None,
            weekly_resets_at: None,
            retry_of_unconfirmed: false,
            trace: ResetTrace::default(),
        }
    }

    /// An outcome decided by one request, and the HTTP status it failed with.
    pub fn at(kind: ResetTicketOutcomeKind, step: ResetStep, http_status: Option<u16>) -> Self {
        let mut outcome = Self::new(kind);
        outcome.trace.step = Some(step);
        outcome.trace.http_status = http_status;
        outcome
    }
}

/// The request that decided a Claude press.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResetStep {
    /// `/api/oauth/profile`, asked only when the token's owner is not cached.
    Profile,
    /// The status check (`/api/oauth/usage?cedar_ember=1`) just before the claim.
    Status,
    /// The claim (`reset_rate_limits`).
    Claim,
}

impl ResetStep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Profile => "profile",
            Self::Status => "status",
            Self::Claim => "claim",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResetTrace {
    pub step: Option<ResetStep>,
    /// The HTTP status that request failed with, when it answered with one.
    pub http_status: Option<u16>,
    /// The status check failed and the claim went out on the remembered status.
    pub remembered_status: bool,
}

/// The status block the last successful usage fetch returned for a Claude row
/// (the poll's or a press's own check), with the owner of the token that asked.
#[derive(Clone, Debug)]
pub struct RememberedClaudeStatus {
    pub account_uuid: String,
    pub organization_uuid: Option<String>,
    pub status: ClaudeStatus,
    /// When the fetch that returned it was sent.
    pub asked_at_ms: i64,
}

/// When a request that can tell `ClaudeStatusMemory` something was sent: its
/// place in the order of such requests, and the wall clock for the age limit.
/// The order decides which answer is newer; wall-clock milliseconds can tie
/// and can step backwards.
#[derive(Clone, Copy, Debug)]
pub struct StatusAsk {
    pub seq: u64,
    pub at_ms: i64,
}

impl StatusAsk {
    /// Taken just before the request is sent.
    pub fn now() -> Self {
        Self { seq: next_status_seq(), at_ms: Utc::now().timestamp_millis() }
    }
}

pub fn next_status_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

/// Per profile, the Claude status a press falls back to when its own status
/// check fails.
#[derive(Default)]
pub struct ClaudeStatusMemory {
    entries: HashMap<String, RememberedClaudeStatus>,
    /// The newest request whose answer was taken (kept or cleared).
    answered_seq: HashMap<String, u64>,
    /// Taken when a claim that may have spent the grant got its answer.
    claim_seq: HashMap<String, u64>,
}

impl ClaudeStatusMemory {
    /// Keep what a successful usage fetch returned, as Claude Code keeps its
    /// last answer. A block saying `unavailable` is a failed answer, so the
    /// previous one stays; a missing block is an answer and clears it. An
    /// answer to a request sent before a newer one was answered writes
    /// nothing, and neither does one sent before a claim got its answer: it
    /// may describe the grant before that claim spent it.
    pub fn remember(
        &mut self,
        profile_id: &str,
        account_uuid: &str,
        organization_uuid: Option<&str>,
        status: Option<&ClaudeStatus>,
        ask: StatusAsk,
    ) {
        let older = |seen: &HashMap<String, u64>| {
            seen.get(profile_id).is_some_and(|&seq| ask.seq < seq)
        };
        if older(&self.claim_seq) || older(&self.answered_seq) {
            return;
        }
        match status {
            Some(status) if !status.eligible
                && status.ineligible_reason.as_deref() == Some("unavailable") => return,
            Some(status) => {
                self.entries.insert(profile_id.to_string(), RememberedClaudeStatus {
                    account_uuid: account_uuid.to_string(),
                    organization_uuid: organization_uuid.map(str::to_string),
                    status: status.clone(),
                    asked_at_ms: ask.at_ms,
                });
            }
            None => {
                self.entries.remove(profile_id);
            }
        }
        self.answered_seq.insert(profile_id.to_string(), ask.seq);
    }

    /// A claim that may have spent the grant (any answer but 429) got its
    /// answer; `seq` is taken after that answer arrived. The remembered status
    /// predates the claim, so it goes, and so does any answer to a request
    /// sent before `seq`.
    pub fn claim_answered(&mut self, profile_id: &str, seq: u64) {
        self.claim_seq.insert(profile_id.to_string(), seq);
        self.entries.remove(profile_id);
    }

    /// The remembered status a failed check may fall back to: same account and
    /// organization, asked at most `max_age_ms` ago, and offering a grant to
    /// use now.
    pub fn usable(
        &self,
        profile_id: &str,
        account_uuid: &str,
        organization_uuid: Option<&str>,
        now: DateTime<Utc>,
        max_age_ms: i64,
    ) -> Option<ClaudeStatus> {
        let entry = self.entries.get(profile_id)?;
        let fresh = now.timestamp_millis().saturating_sub(entry.asked_at_ms) <= max_age_ms;
        (entry.account_uuid == account_uuid
            && entry.organization_uuid.as_deref() == organization_uuid
            && fresh
            && claude_next_grant(&entry.status, now).is_some())
            .then(|| entry.status.clone())
    }

    #[cfg(test)]
    pub fn get(&self, profile_id: &str) -> Option<&RememberedClaudeStatus> {
        self.entries.get(profile_id)
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsettledReset {
    pub identity: String,
    pub request_id: String,
    pub target_id: Option<String>,
    pub started_at_ms: i64,
}

pub fn valid_request_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub fn valid_org_uuid(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn date(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|_| text.to_string())
}

fn after(value: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok_and(|v| v.with_timezone(&Utc) > now)
}

#[derive(Clone, Debug)]
pub struct ClaudeGrant {
    pub id: String,
    label: String,
    #[allow(dead_code)]
    resets_total: u32,
    resets_left: u32,
    #[allow(dead_code)]
    starts_at: Option<String>,
    ends_at: Option<String>,
    clears: Vec<String>,
    paused: bool,
    usable_now: bool,
    use_requires_limit: bool,
    blocking: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ClaudeStatus {
    pub eligible: bool,
    pub ineligible_reason: Option<String>,
    at_limit: bool,
    #[allow(dead_code)]
    exhausted: Vec<String>,
    grants: Vec<ClaudeGrant>,
    next_grant_id: Option<String>,
    cooldown_until: Option<String>,
    #[allow(dead_code)]
    weekly_resets_at: Option<String>,
}

const CLEAR_KEYS: &[&str] = &[
    "five_hour",
    "seven_day",
    "seven_day_overage_included",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_cowork",
    "seven_day_omelette",
    "seven_day_oauth_apps",
];

pub fn parse_claude_status(root: &Value) -> Option<ClaudeStatus> {
    let block = root.get("cedar_ember")?.as_object()?;
    let eligible = block.get("eligible")?.as_bool()?;
    let grants: Vec<_> = block
        .get("grants")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?;
            if id.is_empty()
                || id.len() > 40
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
            {
                return None;
            }
            let resets_left = u32::try_from(entry.get("resets_left")?.as_u64()?).ok()?;
            Some(ClaudeGrant {
                id: id.to_string(),
                label: entry
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                resets_total: entry
                    .get("resets_total")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok())
                    .unwrap_or(0),
                resets_left,
                starts_at: date(entry.get("starts_at")),
                ends_at: date(entry.get("ends_at")),
                clears: entry
                    .get("clears")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|key| CLEAR_KEYS.contains(key))
                    .map(str::to_string)
                    .collect(),
                paused: entry
                    .get("paused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                usable_now: entry
                    .get("usable_now")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                use_requires_limit: entry
                    .get("use_requires_limit")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                blocking: entry
                    .get("blocking")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|key| CLEAR_KEYS.contains(key))
                    .map(str::to_string)
                    .collect(),
            })
        })
        .collect();
    let next_grant_id = block
        .get("next_grant_id")
        .and_then(Value::as_str)
        .filter(|id| grants.iter().any(|grant| grant.id == *id))
        .map(str::to_string);
    Some(ClaudeStatus {
        eligible,
        ineligible_reason: block
            .get("ineligible_reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        at_limit: block
            .get("at_limit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        exhausted: block
            .get("exhausted")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|key| CLEAR_KEYS.contains(key))
            .map(str::to_string)
            .collect(),
        grants,
        next_grant_id,
        cooldown_until: date(block.get("cooldown_until")),
        weekly_resets_at: date(block.get("weekly_resets_at")),
    })
}

pub fn claude_tickets(status: &ClaudeStatus, now: DateTime<Utc>) -> ResetTickets {
    let remaining: Vec<_> = if status.eligible {
        status
            .grants
            .iter()
            .filter(|g| g.resets_left > 0 && g.ends_at.as_deref().is_none_or(|end| after(end, now)))
            .collect()
    } else {
        Vec::new()
    };
    let available = remaining
        .iter()
        .fold(0u32, |sum, grant| sum.saturating_add(grant.resets_left));
    let expires_at = remaining
        .iter()
        .filter_map(|g| g.ends_at.as_deref())
        .min_by_key(|end| DateTime::parse_from_rfc3339(end).ok())
        .map(str::to_string);
    let next = remaining
        .iter()
        .copied()
        .find(|g| Some(g.id.as_str()) == status.next_grant_id.as_deref());
    let selected = next.or_else(|| remaining.first().copied());
    let cooldown = status
        .cooldown_until
        .as_deref()
        .is_some_and(|end| after(end, now));
    let usable_now =
        status.eligible && next.is_some_and(|g| g.usable_now && !g.paused) && !cooldown;
    let blocked_reason = if available == 0 || usable_now {
        None
    } else if cooldown {
        Some(ResetTicketBlockedReason::Cooldown)
    } else if selected.is_some_and(|g| g.paused) {
        Some(ResetTicketBlockedReason::Paused)
    } else if selected.is_some_and(|g| g.use_requires_limit && !status.at_limit) {
        Some(ResetTicketBlockedReason::RequiresLimit)
    } else if selected.is_some_and(|g| !g.blocking.is_empty()) {
        Some(ResetTicketBlockedReason::BlockedByOtherLimit)
    } else {
        Some(ResetTicketBlockedReason::NotOffered)
    };
    ResetTickets {
        available,
        expires_at,
        usable_now,
        blocked_reason,
        clears: selected.map(|g| g.clears.clone()).unwrap_or_default(),
        moves_weekly_reset: false,
        requires_limit: selected.is_some_and(|g| g.use_requires_limit),
        title: selected.and_then(|g| (!g.label.is_empty()).then(|| g.label.clone())),
    }
}

pub fn claude_next_grant(status: &ClaudeStatus, now: DateTime<Utc>) -> Option<&str> {
    let tickets = claude_tickets(status, now);
    tickets.usable_now.then_some(())?;
    status.next_grant_id.as_deref()
}

#[derive(Clone, Debug)]
pub struct CodexCredit {
    pub id: String,
    pub title: Option<String>,
    pub expires_at: Option<String>,
    pub granted_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CachedCredits {
    pub fetched_at_ms: i64,
    pub available_count: u32,
    pub credits: Vec<CodexCredit>,
}

pub fn codex_count(root: &Value) -> Option<u32> {
    let summary = root
        .get("rate_limit_reset_credits")
        .or_else(|| root.get("rateLimitResetCredits"))?;
    u32::try_from(summary.get("available_count")?.as_u64()?).ok()
}

pub fn parse_codex_credits(root: &Value) -> Option<Vec<CodexCredit>> {
    let list = root.get("credits")?.as_array()?;
    Some(
        list.iter()
            .filter(|credit| credit.get("status").and_then(Value::as_str) == Some("available"))
            .filter_map(|credit| {
                Some(CodexCredit {
                    id: credit.get("id")?.as_str()?.to_string(),
                    title: credit
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    expires_at: date(credit.get("expires_at")),
                    granted_at: date(credit.get("granted_at")),
                })
            })
            .collect(),
    )
}

pub fn soonest_credit(credits: &[CodexCredit]) -> Option<&CodexCredit> {
    credits.iter().min_by_key(|credit| {
        credit
            .expires_at
            .as_ref()
            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.with_timezone(&Utc))
            .unwrap_or(DateTime::<Utc>::MAX_UTC)
    })
}

pub fn codex_tickets(available: u32, details: Option<&CachedCredits>) -> ResetTickets {
    let credit = details.and_then(|entry| soonest_credit(&entry.credits));
    ResetTickets {
        available,
        expires_at: credit.and_then(|c| c.expires_at.clone()),
        usable_now: available > 0,
        blocked_reason: None,
        clears: vec!["five_hour".into(), "seven_day".into()],
        moves_weekly_reset: true,
        requires_limit: false,
        title: credit.and_then(|c| c.title.clone()),
    }
}

pub fn map_claude_outcome(status: u16, body: &str) -> ResetTicketOutcome {
    use ResetTicketOutcomeKind::*;
    if status == 429 {
        return ResetTicketOutcome::at(RateLimited, ResetStep::Claim, Some(status));
    }
    if status == 401 || status == 403 {
        return ResetTicketOutcome::at(AuthError, ResetStep::Claim, Some(status));
    }
    if status != 200 {
        return ResetTicketOutcome::at(Unconfirmed, ResetStep::Claim, Some(status));
    }
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return ResetTicketOutcome::at(Unconfirmed, ResetStep::Claim, None);
    };
    let kind = match value.get("result").and_then(Value::as_str) {
        Some("reset") => Reset,
        Some("already_used") => AlreadyUsed,
        Some("not_limited") => NothingToReset,
        Some("cooldown") => Cooldown,
        Some("ineligible") => NoTicket,
        _ => Unconfirmed,
    };
    ResetTicketOutcome {
        kind,
        resets_left: if kind == Reset {
            value
                .get("resets_left")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
        } else {
            None
        },
        weekly_resets_at: if kind == Reset {
            date(value.get("weekly_resets_at"))
        } else {
            None
        },
        retry_of_unconfirmed: false,
        trace: ResetTrace { step: Some(ResetStep::Claim), ..ResetTrace::default() },
    }
}

pub fn map_codex_outcome(status: u16, body: &str) -> ResetTicketOutcome {
    use ResetTicketOutcomeKind::*;
    if status == 429 {
        return ResetTicketOutcome::new(RateLimited);
    }
    if status == 401 || status == 403 {
        return ResetTicketOutcome::new(AuthError);
    }
    if status != 200 {
        return ResetTicketOutcome::new(Unconfirmed);
    }
    let kind = match serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
        .as_deref()
    {
        Some("reset") => Reset,
        Some("already_redeemed") => AlreadyUsed,
        Some("nothing_to_reset") => NothingToReset,
        Some("no_credit") => NoTicket,
        _ => Unconfirmed,
    };
    ResetTicketOutcome::new(kind)
}

#[cfg(test)]
pub async fn fake_http_once(
    response_body: &'static str,
) -> (String, tokio::task::JoinHandle<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let n = stream.read(&mut buffer).await.unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= header_end + 4 + length {
                    break;
                }
            }
        }
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(), response_body);
        stream.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8(bytes).unwrap()
    });
    (url, handle)
}

#[cfg(test)]
pub async fn fake_http_sequence(
    responses: Vec<(u16, String)>,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = stream.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(bytes).unwrap());
            let label = if status == 200 { "OK" } else { "Failure" };
            let response = format!("HTTP/1.1 {status} {label}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).await.unwrap();
        }
        if let Ok(Ok((mut stream, _))) =
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept()).await
        {
            let mut buffer = [0u8; 4096];
            if let Ok(n) = stream.read(&mut buffer).await {
                requests.push(String::from_utf8_lossy(&buffer[..n]).into_owned());
            }
        }
        requests
    });
    (url, handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn sample(name: &str) -> Value {
        let text = match name {
            "claude_usage_cedar_ember_cli_ua.json" => {
                include_str!("testdata/claude_usage_cedar_ember_cli_ua.json")
            }
            "claude_usage_cedar_ember_old_ua_surface_ineligible.json" => {
                include_str!("testdata/claude_usage_cedar_ember_old_ua_surface_ineligible.json")
            }
            "claude_usage_plain_old_ua.json" => {
                include_str!("testdata/claude_usage_plain_old_ua.json")
            }
            "codex_wham_usage_sanitized.json" => {
                include_str!("testdata/codex_wham_usage_sanitized.json")
            }
            "codex_wham_rate_limit_reset_credits_sanitized.json" => {
                include_str!("testdata/codex_wham_rate_limit_reset_credits_sanitized.json")
            }
            _ => panic!("unknown fixture"),
        };
        serde_json::from_str(text).unwrap()
    }
    #[test]
    fn claude_samples_and_blocking() {
        let sample = sample("claude_usage_cedar_ember_cli_ua.json");
        let now = DateTime::parse_from_rfc3339("2026-09-28T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let status = parse_claude_status(&sample).unwrap();
        let tickets = claude_tickets(&status, now);
        assert_eq!(tickets.available, 1);
        assert!(tickets.usable_now);
        assert_eq!(
            tickets.expires_at.as_deref(),
            Some("2026-10-22T16:00:00+00:00")
        );
        assert_eq!(claude_next_grant(&status, now), Some("synthetic-grant-1"));
        let mut modified = sample;
        modified["cedar_ember"]["next_grant_id"] = json!("unknown");
        assert_eq!(
            claude_tickets(&parse_claude_status(&modified).unwrap(), now).blocked_reason,
            Some(ResetTicketBlockedReason::NotOffered)
        );
        modified["cedar_ember"]["grants"][0]["paused"] = json!(true);
        assert_eq!(
            claude_tickets(&parse_claude_status(&modified).unwrap(), now).blocked_reason,
            Some(ResetTicketBlockedReason::Paused)
        );
    }
    #[test]
    fn claude_malformed_and_expired_grants() {
        let now = DateTime::parse_from_rfc3339("2026-09-28T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let grant = json!({"id":"valid-1","resets_left":2,"usable_now":true,"use_requires_limit":false,
            "ends_at":"2026-10-22T16:00:00+00:00","clears":["five_hour","unknown"]});
        let make = |grants: Value, next: Value, more: Value| {
            let mut block =
                json!({"eligible":true,"at_limit":false,"grants":grants,"next_grant_id":next});
            for (key, value) in more.as_object().unwrap() {
                block[key] = value.clone();
            }
            parse_claude_status(&json!({"cedar_ember":block})).unwrap()
        };
        let status = make(
            json!([{"id":"BAD","resets_left":1},{"id":"negative","resets_left":-1},grant]),
            json!("valid-1"),
            json!({}),
        );
        assert_eq!(claude_tickets(&status, now).available, 2);
        assert_eq!(
            claude_tickets(&status, now).clears,
            vec!["five_hour".to_string()]
        );
        let status = make(
            json!([{"id":"old","resets_left":1,"ends_at":"2026-09-27T00:00:00Z"}]),
            json!("old"),
            json!({}),
        );
        assert_eq!(claude_tickets(&status, now).available, 0);
        let status = make(
            json!([{"id":"need","resets_left":1,"use_requires_limit":true}]),
            json!("need"),
            json!({}),
        );
        assert_eq!(
            claude_tickets(&status, now).blocked_reason,
            Some(ResetTicketBlockedReason::RequiresLimit)
        );
        let status = make(
            json!([{"id":"valid-1","resets_left":1,"usable_now":true,"use_requires_limit":false}]),
            json!("valid-1"),
            json!({"cooldown_until":"2026-09-29T00:00:00Z"}),
        );
        assert_eq!(
            claude_tickets(&status, now).blocked_reason,
            Some(ResetTicketBlockedReason::Cooldown)
        );
    }
    #[test]
    fn provider_samples_and_outcome_edges() {
        let read = sample;
        let now = Utc::now();
        let surface = parse_claude_status(&read(
            "claude_usage_cedar_ember_old_ua_surface_ineligible.json",
        ))
        .unwrap();
        assert!(!surface.eligible);
        assert_eq!(surface.ineligible_reason.as_deref(), Some("surface"));
        assert_eq!(claude_tickets(&surface, now).available, 0);
        assert!(parse_claude_status(&read("claude_usage_plain_old_ua.json")).is_none());
        assert!(parse_claude_status(&json!({"cedar_ember":{"eligible":"yes"}})).is_none());
        let usage = read("codex_wham_usage_sanitized.json");
        assert_eq!(codex_count(&usage), Some(1));
        assert_eq!(
            codex_count(&json!({"rateLimitResetCredits":{"available_count":2}})),
            Some(2)
        );
        assert_eq!(codex_count(&json!({})), None);
        let credits =
            parse_codex_credits(&read("codex_wham_rate_limit_reset_credits_sanitized.json"))
                .unwrap();
        assert_eq!(credits.len(), 1);
        assert_eq!(credits[0].title.as_deref(), Some("Full reset"));
        assert_eq!(
            parse_codex_credits(&json!({"credits":[
                {"id":"used","status":"redeemed"}, {"id":"active","status":"available","title":"A"}
            ]}))
            .unwrap()
            .len(),
            1
        );
        let details = CachedCredits {
            fetched_at_ms: 0,
            available_count: 1,
            credits,
        };
        assert_eq!(
            codex_tickets(1, Some(&details)).expires_at.as_deref(),
            Some("2026-10-22T20:46:05.210547Z")
        );
        for status in [401, 403] {
            assert_eq!(
                map_claude_outcome(status, "{}").kind,
                ResetTicketOutcomeKind::AuthError
            );
            assert_eq!(
                map_codex_outcome(status, "{}").kind,
                ResetTicketOutcomeKind::AuthError
            );
        }
        assert_eq!(
            map_claude_outcome(429, "{}").kind,
            ResetTicketOutcomeKind::RateLimited
        );
        assert_eq!(
            map_codex_outcome(429, "{}").kind,
            ResetTicketOutcomeKind::RateLimited
        );
        for body in ["not-json", "{}", r#"{"result":"mystery"}"#] {
            assert_eq!(
                map_claude_outcome(200, body).kind,
                ResetTicketOutcomeKind::Unconfirmed
            );
        }
        for body in ["not-json", "{}", r#"{"code":"mystery"}"#] {
            assert_eq!(
                map_codex_outcome(200, body).kind,
                ResetTicketOutcomeKind::Unconfirmed
            );
        }
        assert_eq!(
            map_claude_outcome(500, "{}").kind,
            ResetTicketOutcomeKind::Unconfirmed
        );
        assert_eq!(
            map_codex_outcome(500, "{}").kind,
            ResetTicketOutcomeKind::Unconfirmed
        );
        let reset = map_claude_outcome(
            200,
            r#"{"result":"reset","resets_left":2,"weekly_resets_at":"2026-10-03T00:00:00Z"}"#,
        );
        assert_eq!(reset.resets_left, Some(2));
        assert_eq!(
            reset.weekly_resets_at.as_deref(),
            Some("2026-10-03T00:00:00Z")
        );
    }
    #[test]
    fn status_memory_keeps_the_last_answer_until_a_claim_may_have_spent_it() {
        let status = |block: serde_json::Value| {
            parse_claude_status(&serde_json::json!({ "cedar_ember": block })).unwrap()
        };
        let usable = status(serde_json::json!({
            "eligible": true, "at_limit": true, "next_grant_id": "grant-a",
            "grants": [{"id": "grant-a", "resets_left": 3, "usable_now": true}],
        }));
        let unavailable = status(serde_json::json!({
            "eligible": false, "ineligible_reason": "unavailable",
        }));
        let surface = status(serde_json::json!({
            "eligible": false, "ineligible_reason": "surface",
        }));
        let now = Utc::now();
        // Requests in the order they were sent; the clock only ages them.
        let ask = |seq: u64| StatusAsk { seq, at_ms: now.timestamp_millis() - 60_000 };
        let usable_for = |memory: &ClaudeStatusMemory, account: &str, org: Option<&str>| {
            memory.usable("p", account, org, now, 600_000).is_some()
        };

        let mut memory = ClaudeStatusMemory::default();
        memory.remember("p", "account-a", Some("org-a"), Some(&usable), ask(10));
        assert!(usable_for(&memory, "account-a", Some("org-a")));
        assert!(!usable_for(&memory, "account-b", Some("org-a")), "another account");
        assert!(!usable_for(&memory, "account-a", Some("org-b")), "another organization");
        assert!(!usable_for(&memory, "account-a", None), "an owner without an organization");
        assert!(memory.usable("p", "account-a", Some("org-a"), now, 59_999).is_none(), "too old");
        assert!(memory.usable("q", "account-a", Some("org-a"), now, 600_000).is_none());

        memory.remember("p", "account-a", Some("org-a"), Some(&unavailable), ask(11));
        assert!(usable_for(&memory, "account-a", Some("org-a")),
            "an `unavailable` block is a failed answer and keeps the last one");
        memory.remember("p", "account-a", Some("org-a"), Some(&surface), ask(13));
        assert!(memory.get("p").is_some_and(|entry| !entry.status.eligible));
        assert!(!usable_for(&memory, "account-a", Some("org-a")), "a real answer replaces it");
        memory.remember("p", "account-a", Some("org-a"), Some(&usable), ask(12));
        assert!(!usable_for(&memory, "account-a", Some("org-a")),
            "an answer to a request sent before the kept one arrived late and is older");
        memory.remember("p", "account-a", Some("org-a"), None, ask(14));
        assert!(memory.is_empty(), "a missing block is an answer and clears it");
        memory.remember("p", "account-a", Some("org-a"), Some(&usable), ask(12));
        assert!(memory.is_empty(), "a late older answer does not undo a newer clear either");

        memory.remember("p", "account-a", Some("org-a"), Some(&usable), ask(20));
        memory.claim_answered("p", 25);
        assert!(memory.is_empty(), "a claim that may have spent the grant drops it");
        memory.remember("p", "account-a", Some("org-a"), Some(&usable), ask(24));
        assert!(memory.is_empty(),
            "a request sent before the claim's answer must not bring the spent grant back");
        memory.remember("p", "account-a", Some("org-a"), Some(&usable), ask(26));
        assert!(usable_for(&memory, "account-a", Some("org-a")), "a later request is news");
        assert!(next_status_seq() < next_status_seq(), "the order only moves forward");
    }

    #[test]
    fn trace_stays_off_the_wire_and_names_the_claim() {
        let traced = map_claude_outcome(429, "{}");
        assert_eq!(traced.trace.step, Some(ResetStep::Claim));
        assert_eq!(traced.trace.http_status, Some(429));
        assert!(!traced.trace.remembered_status);
        let wire = serde_json::to_value(&traced).unwrap();
        let mut keys: Vec<_> = wire.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["kind", "resets_left", "retry_of_unconfirmed", "weekly_resets_at"]);
        let answered = map_claude_outcome(200, r#"{"result":"reset"}"#);
        assert_eq!(answered.trace.step, Some(ResetStep::Claim));
        assert_eq!(answered.trace.http_status, None);
        assert_eq!(map_claude_outcome(500, "{}").trace.http_status, Some(500));
    }

    #[test]
    fn outcome_and_validation() {
        assert_eq!(
            serde_json::to_value(ResetTicketOutcome::new(ResetTicketOutcomeKind::Busy)).unwrap()
                ["retry_of_unconfirmed"],
            serde_json::Value::Bool(false)
        );
        assert!(valid_request_id("a_-0"));
        assert!(!valid_request_id(""));
        assert!(!valid_request_id("a/b"));
        assert!(!valid_request_id(&"a".repeat(65)));
        assert!(valid_org_uuid("a-0"));
        assert!(!valid_org_uuid("a_b"));
        assert!(!valid_org_uuid(&"a".repeat(65)));
        for (result, kind) in [
            ("reset", ResetTicketOutcomeKind::Reset),
            ("already_used", ResetTicketOutcomeKind::AlreadyUsed),
            ("not_limited", ResetTicketOutcomeKind::NothingToReset),
            ("cooldown", ResetTicketOutcomeKind::Cooldown),
            ("ineligible", ResetTicketOutcomeKind::NoTicket),
            ("unavailable", ResetTicketOutcomeKind::Unconfirmed),
        ] {
            assert_eq!(
                map_claude_outcome(200, &format!(r#"{{"result":"{result}"}}"#)).kind,
                kind
            );
        }
        for (code, kind) in [
            ("reset", ResetTicketOutcomeKind::Reset),
            ("already_redeemed", ResetTicketOutcomeKind::AlreadyUsed),
            ("nothing_to_reset", ResetTicketOutcomeKind::NothingToReset),
            ("no_credit", ResetTicketOutcomeKind::NoTicket),
        ] {
            assert_eq!(
                map_codex_outcome(200, &format!(r#"{{"code":"{code}"}}"#)).kind,
                kind
            );
        }
    }
}
