use chrono::Utc;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock};

use crate::cli_accounts::{
    claude::{self, ClaudePaths},
    codex::{self, CodexPaths},
    grok::{self, GrokPaths},
    token_owner::{self, OwnerCheck, TokenOwner},
    CliAccountProfile, CliLiveLogin, CliProvider, ForeignTokenOwner, SnapshotUpdate,
};
use crate::usage::{
    credentials, oauth_claude, oauth_codex, oauth_grok, refresh, AccountUsageReport, CachedWindows, Cooldown,
    ProfileUsage, UsageRowState, UsageState, USAGE_CACHE_TTL_MS,
};
use crate::usage::reset_tickets::{self, ResetTickets, CachedCredits, UnsettledReset};
use crate::usage::reset_tickets::{ResetTicketOutcome, ResetTicketOutcomeKind};
use tauri::Manager;

const COOLDOWN_BASE_MS: i64 = 300_000;
const COOLDOWN_MAX_MS: i64 = 1_800_000;
/// Ceiling on outbound requests per poll, counted separately for each provider
/// (see `RoundBudget`). Counted in requests, not rows: a row that has to
/// refresh spends two (refresh + usage), and one that refreshes after a 401
/// spends three. Anthropic rate-limits by IP, so the budget belongs to the
/// whole round rather than to each account. Rows that run out of budget go
/// first on the next round (see `deferred_priority`), so a long account list
/// rotates through instead of starving its tail.
const MAX_FETCH_PER_ROUND: usize = 12;
/// How old a row's last numbers may be and still stand in for a round that had
/// no budget left for it. A deferred row is served early next round (behind
/// only the logged-in accounts), so its numbers are normally one poll interval
/// (180s) old; the ceiling keeps a wake from sleep from passing hours-old
/// figures off as current.
const DEFERRED_STALE_MAX_MS: i64 = 600_000;
const ERROR_FOREIGN_TOKEN: &str = "usage.error.foreign_token";
const ERROR_LIVE_TOKEN_FOREIGN: &str = "usage.error.live_token_foreign";
const ERROR_RATE_LIMITED: &str = "usage.error.rate_limited";
const ERROR_NEEDS_RELOGIN: &str = "usage.error.needs_relogin";
const ERROR_TOKEN_EXPIRED_ACTIVE: &str = "usage.error.token_expired_active";
const ERROR_CODEX_UNSUPPORTED: &str = "usage.error.codex_unsupported";
const ERROR_GROK_UNSUPPORTED: &str = "usage.error.grok_unsupported";
// Like Codex, an unsupported endpoint stays disabled until the app restarts.
// Serialize refresh attempts so concurrent polls cannot send after the stop.
static GROK_REFRESH_DISABLED: AtomicBool = AtomicBool::new(false);
static GROK_REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const ERROR_NETWORK: &str = "usage.error.network";
const ERROR_UPSTREAM: &str = "usage.error.upstream";
const ERROR_SNAPSHOT_UNAVAILABLE: &str = "usage.error.snapshot_unavailable";
const ERROR_SNAPSHOT_CONFLICT: &str = "usage.error.snapshot_conflict";
const ERROR_DEFERRED: &str = "usage.error.deferred";

/// Anthropic rate-limits by IP, so a second 429 in the same round is evidence
/// about the address rather than about one account. Pausing the whole provider
/// at that point stops the remaining rows from spending the rate budget on
/// requests that are already known to fail.
const PROVIDER_PAUSE_THRESHOLD: usize = 2;

fn profile_cooldown_key(profile_id: &str) -> String {
    format!("profile:{profile_id}")
}

fn provider_cooldown_key(provider: CliProvider) -> String {
    match provider {
        CliProvider::Claude => "provider:claude".to_string(),
        CliProvider::Codex => "provider:codex".to_string(),
        CliProvider::Grok => "provider:grok".to_string(),
    }
}

#[derive(Clone)]
struct PlannedRow {
    profile_id: String,
    provider: CliProvider,
    label: String,
    email: Option<String>,
    plan: Option<String>,
    identity_key: Option<String>,
    registered: bool,
    is_active: bool,
    needs_relogin: bool,
    foreign_owner: Option<ForeignTokenOwner>,
}

fn planned_rows(profiles: &[CliAccountProfile], live: &[CliLiveLogin]) -> Vec<PlannedRow> {
    let mut rows = profiles
        .iter()
        .map(|profile| PlannedRow {
            profile_id: profile.id.clone(),
            provider: profile.provider,
            label: profile.label.clone(),
            email: profile.email.clone(),
            plan: profile.plan.clone(),
            identity_key: Some(profile.identity_key.clone()),
            registered: true,
            is_active: live.iter().any(|login| {
                login.provider == profile.provider
                    && login.present
                    && login.identity_key.as_deref() == Some(profile.identity_key.as_str())
            }),
            needs_relogin: profile.needs_relogin,
            foreign_owner: profile.foreign_token_owner.clone(),
        })
        .collect::<Vec<_>>();
    for login in live
        .iter()
        .filter(|login| login.present && login.matched_profile_id.is_none())
    {
        rows.push(PlannedRow {
            profile_id: match login.provider {
                CliProvider::Claude => "live:claude",
                CliProvider::Codex => "live:codex",
                CliProvider::Grok => "live:grok",
            }
            .into(),
            provider: login.provider,
            label: login.email.clone().unwrap_or_else(|| {
                match login.provider {
                    CliProvider::Claude => "Claude live login",
                    CliProvider::Codex => "Codex live login",
                    CliProvider::Grok => "Grok live login",
                }
                .into()
            }),
            email: login.email.clone(),
            plan: login.plan.clone(),
            identity_key: login.identity_key.clone(),
            registered: false,
            is_active: true,
            needs_relogin: false,
            foreign_owner: None,
        });
    }
    rows.sort_by(|left, right| {
        (provider_rank(left.provider), &left.label, &left.profile_id).cmp(&(
            provider_rank(right.provider),
            &right.label,
            &right.profile_id,
        ))
    });
    rows
}

fn provider_rank(provider: CliProvider) -> u8 {
    match provider {
        CliProvider::Claude => 0,
        CliProvider::Codex => 1,
        CliProvider::Grok => 2,
    }
}

fn profile_usage(
    row: &PlannedRow,
    state: UsageRowState,
    error_code: Option<&str>,
    retry_at: Option<String>,
) -> ProfileUsage {
    ProfileUsage {
        profile_id: row.profile_id.clone(),
        provider: row.provider,
        label: row.label.clone(),
        email: row.email.clone(),
        plan: row.plan.clone(),
        registered: row.registered,
        is_active: row.is_active,
        needs_relogin: row.needs_relogin,
        state,
        five_hour: None,
        seven_day: None,
        seven_day_sonnet: None,
        seven_day_opus: None,
        model_windows: Vec::new(),
        reset_tickets: None,
        error_code: error_code.map(str::to_string),
        token_owner_email: None,
        retry_at,
        fetched_at: Utc::now().to_rfc3339(),
    }
}

async fn cached_profile_windows(
    state: &UsageState,
    profile_id: &str,
    now_ms: i64,
) -> Option<CachedWindows> {
    state
        .profile_usage_cache
        .lock()
        .await
        .get(profile_id)
        .filter(|cached| {
            !cached.invalidated
                && now_ms.saturating_sub(cached.fetched_at_ms) < USAGE_CACHE_TTL_MS
        })
        .cloned()
}

/// The last successful numbers regardless of age. A row in cooldown is not
/// allowed to ask for fresh ones, so an expired entry is still the best answer
/// it has.
async fn stale_profile_windows(state: &UsageState, profile_id: &str) -> Option<CachedWindows> {
    state
        .profile_usage_cache
        .lock()
        .await
        .get(profile_id)
        .cloned()
}

/// A cooldown pauses the asking, not the numbers: the row keeps the last
/// successful windows (with their original fetched_at, so the UI can date
/// them) instead of going blank for up to half an hour.
async fn cooldown_usage(
    state: &UsageState,
    row: &PlannedRow,
    retry_at: Option<String>,
) -> ProfileUsage {
    let usage = profile_usage(
        row,
        UsageRowState::Cooldown,
        Some(ERROR_RATE_LIMITED),
        retry_at,
    );
    match stale_profile_windows(state, &row.profile_id).await {
        Some(stale) => with_windows(usage, stale),
        None => usage,
    }
}

fn with_windows(mut usage: ProfileUsage, windows: CachedWindows) -> ProfileUsage {
    usage.five_hour = windows.five_hour;
    usage.seven_day = windows.seven_day;
    usage.seven_day_sonnet = windows.seven_day_sonnet;
    usage.seven_day_opus = windows.seven_day_opus;
    usage.model_windows = windows.model_windows;
    usage.reset_tickets = windows.reset_tickets;
    usage.fetched_at = rfc3339(windows.fetched_at_ms);
    usage
}

fn snapshot_text(
    base: &std::path::Path,
    profile_id: &str,
    provider: CliProvider,
) -> Result<String, String> {
    let text = std::fs::read_to_string(
        base.join("cli_account_snapshots")
            .join(format!("{profile_id}.json")),
    )
    .map_err(|_| ERROR_SNAPSHOT_UNAVAILABLE.to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| ERROR_SNAPSHOT_UNAVAILABLE.to_string())?;
    match provider {
        CliProvider::Claude => value
            .get("credentials_text")
            .and_then(serde_json::Value::as_str),
        CliProvider::Codex => value.get("auth_text").and_then(serde_json::Value::as_str),
        CliProvider::Grok => value.get("grok_auth_text").and_then(serde_json::Value::as_str),
    }
    .map(str::to_string)
    .ok_or_else(|| ERROR_SNAPSHOT_UNAVAILABLE.to_string())
}

fn token_source(row: &PlannedRow, base: &std::path::Path) -> Result<String, String> {
    if row.is_active || !row.registered {
        match row.provider {
            // On macOS Claude credentials may live in the login keychain.
            CliProvider::Claude => ClaudePaths::resolve()
                .ok()
                .and_then(|paths| claude::read_credentials(&paths)),
            CliProvider::Codex => CodexPaths::resolve()
                .ok()
                .and_then(|paths| std::fs::read_to_string(paths.auth).ok()),
            CliProvider::Grok => GrokPaths::resolve()
                .ok()
                .and_then(|paths| std::fs::read_to_string(paths.auth).ok()),
        }.ok_or_else(|| ERROR_SNAPSHOT_UNAVAILABLE.to_string())
    } else {
        snapshot_text(base, &row.profile_id, row.provider)
    }
}

struct ResetFlight<'a> {
    state: &'a UsageState,
    profile_id: String,
}
impl Drop for ResetFlight<'_> {
    fn drop(&mut self) {
        self.state.reset_in_flight.lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.profile_id);
    }
}

struct ResetEndpoints<'a> {
    claude_base: &'a str,
    claude_profile_url: &'a str,
    claude_usage_url: &'a str,
    codex_usage_url: Option<&'a str>,
}

impl ResetEndpoints<'static> {
    fn production() -> Self {
        Self {
            claude_base: "https://api.anthropic.com",
            claude_profile_url: token_owner::CLAUDE_PROFILE_URL,
            claude_usage_url: oauth_claude::USAGE_URL,
            codex_usage_url: None,
        }
    }
}

async fn stale_reset_usage(state: &UsageState, profile_id: &str) {
    if let Some(cached) = state.profile_usage_cache.lock().await.get_mut(profile_id) {
        cached.invalidated = true;
    }
}

async fn live_unsettled(
    state: &UsageState,
    key: &str,
    identity: &str,
) -> Option<UnsettledReset> {
    let now = Utc::now().timestamp_millis();
    let mut unsettled = state.reset_unsettled.lock().await;
    if unsettled.get(key).is_some_and(|entry| {
        entry.identity == identity && now.saturating_sub(entry.started_at_ms) >= 600_000
    }) {
        unsettled.remove(key);
    }
    unsettled.get(key)
        .filter(|entry| entry.identity == identity)
        .cloned()
}

async fn settle_reset(
    state: &UsageState,
    key: &str,
    identity: &str,
    request_id: &str,
    target_id: Option<&str>,
    reuse: Option<&UnsettledReset>,
    started_at_ms: i64,
    outcome: &ResetTicketOutcome,
) {
    use ResetTicketOutcomeKind::*;
    let mut unsettled = state.reset_unsettled.lock().await;
    match outcome.kind {
        Reset | AlreadyUsed | OfferChanged | NothingToReset | NoTicket => {
            unsettled.remove(key);
        }
        Unconfirmed => {
            unsettled.insert(
                key.to_string(),
                UnsettledReset {
                    identity: identity.to_string(),
                    request_id: request_id.to_string(),
                    target_id: target_id.map(str::to_string),
                    started_at_ms: reuse.map_or(started_at_ms, |entry| entry.started_at_ms),
                },
            );
        }
        Cooldown | RateLimited | AuthError if reuse.is_none() => {
            unsettled.remove(key);
        }
        _ => {}
    }
}

#[tauri::command(async)]
pub async fn use_reset_ticket(
    app: tauri::AppHandle,
    state: tauri::State<'_, UsageState>,
    profile_id: String,
    request_id: String,
    expected_email: Option<String>,
) -> Result<ResetTicketOutcome, String> {
    let default_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let base = crate::test_profile::app_data_dir_from(default_dir);
    let accounts = crate::cli_accounts::list_resolved(&base)?;
    let row = planned_rows(&accounts.profiles, &accounts.live)
        .into_iter()
        .find(|row| row.profile_id == profile_id)
        .ok_or_else(|| "Unknown profile id".to_string())?;
    let source = if row.foreign_owner.is_some() || row.needs_relogin {
        Err(ERROR_SNAPSHOT_UNAVAILABLE.to_string())
    } else {
        token_source(&row, &base)
    };
    let outcome = use_reset_ticket_inner(
        &state, &row, source, &request_id,
        expected_email.as_deref(), &ResetEndpoints::production(),
    ).await?;
    let kind = serde_json::to_value(outcome.kind).unwrap_or_default();
    let provider = match row.provider {
        CliProvider::Claude => "claude",
        CliProvider::Codex => "codex",
        CliProvider::Grok => "grok",
    };
    crate::usage::log_oauth_failure(
        &app, "reset_ticket_use",
        &format!("profile={} provider={} outcome={}",
            row.profile_id, provider, kind.as_str().unwrap_or("unavailable")),
    );
    Ok(outcome)
}

async fn use_reset_ticket_inner(
    state: &UsageState,
    row: &PlannedRow,
    source: Result<String, String>,
    request_id: &str,
    expected_email: Option<&str>,
    endpoints: &ResetEndpoints<'_>,
) -> Result<ResetTicketOutcome, String> {
    use ResetTicketOutcomeKind::*;
    if !reset_tickets::valid_request_id(request_id) {
        return Err("Invalid request id".into());
    }
    if row.provider == CliProvider::Grok {
        return Err("Reset tickets are not supported for Grok".into());
    }
    {
        let mut in_flight = state.reset_in_flight.lock().unwrap_or_else(|error| error.into_inner());
        if !in_flight.insert(row.profile_id.clone()) {
            return Ok(ResetTicketOutcome::new(Busy));
        }
    }
    let _flight = ResetFlight { state, profile_id: row.profile_id.clone() };
    let started_at_ms = Utc::now().timestamp_millis();
    let outcome = if row.foreign_owner.is_some() || expected_email.zip(row.email.as_deref())
        .is_some_and(|(expected, current)| !expected.eq_ignore_ascii_case(current)) {
        ResetTicketOutcome::new(OwnerMismatch)
    } else if row.needs_relogin {
        ResetTicketOutcome::new(AuthError)
    } else if let Ok(source) = source {
        match row.provider {
            CliProvider::Claude => {
                claim_claude_ticket(state, row, &source, request_id, started_at_ms, endpoints).await
            }
            CliProvider::Codex => {
                claim_codex_ticket(state, row, &source, request_id, started_at_ms, endpoints).await
            }
            CliProvider::Grok => unreachable!(),
        }
    } else {
        ResetTicketOutcome::new(TokenStale)
    };
    Ok(outcome)
}

async fn claim_claude_ticket(
    state: &UsageState,
    row: &PlannedRow,
    source: &str,
    request_id: &str,
    started_at_ms: i64,
    endpoints: &ResetEndpoints<'_>,
) -> ResetTicketOutcome {
    use ResetTicketOutcomeKind::*;
    let Ok(tokens) = credentials::claude_tokens(source) else {
        return ResetTicketOutcome::new(TokenStale);
    };
    match credentials::plan_token_source(
        row.is_active, Some(tokens.expires_at_ms), tokens.refresh_expires_at_ms,
        Utc::now().timestamp_millis(),
    ) {
        credentials::TokenPlan::UseLive | credentials::TokenPlan::UseSnapshot => {},
        credentials::TokenPlan::NeedsRelogin => return ResetTicketOutcome::new(AuthError),
        _ => return ResetTicketOutcome::new(TokenStale),
    }
    let owner = if let Some(owner) = token_owner::cached_owner(&tokens.access_token)
        .filter(|owner| owner.organization_uuid.is_some()) {
        OwnerCheck::Owner(owner)
    } else {
        let result = token_owner::fetch_claude_token_owner_at(&state.http,
            &tokens.access_token, endpoints.claude_profile_url).await;
        stale_reset_usage(state, &row.profile_id).await;
        if let OwnerCheck::Owner(owner) = &result {
            token_owner::remember_owner(&tokens.access_token, owner);
        }
        result
    };
    let owner = match owner {
        OwnerCheck::Owner(owner) => owner,
        OwnerCheck::Rejected { .. } => return ResetTicketOutcome::new(AuthError),
        OwnerCheck::RateLimited { .. } => return ResetTicketOutcome::new(RateLimited),
        OwnerCheck::Unavailable => return ResetTicketOutcome::new(Unavailable),
    };
    if row.identity_key.as_deref().is_some_and(|identity| identity != owner.account_uuid) {
        return ResetTicketOutcome::new(OwnerMismatch);
    }
    let key = format!("claude:{}", owner.account_uuid);
    let reuse = live_unsettled(state, &key, &owner.account_uuid).await;
    let request_id = reuse
        .as_ref()
        .map_or(request_id, |entry| entry.request_id.as_str());
    let mut outcome = claim_claude_verified(
        state, row, &tokens.access_token, &owner, &key, request_id,
        reuse.as_ref(), started_at_ms, endpoints,
    ).await;
    outcome.retry_of_unconfirmed = reuse.is_some();
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn claim_claude_verified(
    state: &UsageState,
    row: &PlannedRow,
    access_token: &str,
    owner: &token_owner::TokenOwner,
    key: &str,
    request_id: &str,
    reuse: Option<&UnsettledReset>,
    started_at_ms: i64,
    endpoints: &ResetEndpoints<'_>,
) -> ResetTicketOutcome {
    use ResetTicketOutcomeKind::*;
    let Some(org) = owner.organization_uuid.as_deref()
        .filter(|org| reset_tickets::valid_org_uuid(org)) else {
        return ResetTicketOutcome::new(Unavailable);
    };
    let checked = oauth_claude::fetch_with_token_status_at(&state.http,
        access_token, endpoints.claude_usage_url).await;
    stale_reset_usage(state, &row.profile_id).await;
    let status = match checked {
        Ok(usage) => usage.reset_status,
        Err((Some(401 | 403), _)) => return ResetTicketOutcome::new(AuthError),
        Err((Some(429), _)) => return ResetTicketOutcome::new(RateLimited),
        Err(_) => return ResetTicketOutcome::new(Unavailable),
    };
    let Some(status) = status else {
        return ResetTicketOutcome::new(Unavailable);
    };
    if !status.eligible && status.ineligible_reason.as_deref() == Some("unavailable") {
        return ResetTicketOutcome::new(Unavailable);
    }
    let now = Utc::now();
    let tickets = reset_tickets::claude_tickets(&status, now);
    if tickets.available == 0 {
        state.reset_unsettled.lock().await.remove(key);
        return ResetTicketOutcome::new(NoTicket);
    }
    if tickets.blocked_reason == Some(reset_tickets::ResetTicketBlockedReason::Cooldown) {
        return ResetTicketOutcome::new(Cooldown);
    }
    let Some(grant_id) = reset_tickets::claude_next_grant(&status, now) else {
        let kind = if tickets.blocked_reason
            == Some(reset_tickets::ResetTicketBlockedReason::RequiresLimit) {
            NothingToReset
        } else {
            Unavailable
        };
        return ResetTicketOutcome::new(kind);
    };
    if reuse.is_some_and(|entry| entry.target_id.as_deref() != Some(grant_id)) {
        state.reset_unsettled.lock().await.remove(key);
        return ResetTicketOutcome::new(OfferChanged);
    }
    let Some(claim_http) = state.reset_http.as_ref() else {
        return ResetTicketOutcome::new(Unavailable);
    };
    let outcome = oauth_claude::claim_at(claim_http, endpoints.claude_base, access_token,
        org, grant_id, request_id).await;
    stale_reset_usage(state, &row.profile_id).await;
    settle_reset(state, key, &owner.account_uuid, request_id, Some(grant_id), reuse,
        started_at_ms, &outcome).await;
    outcome
}

async fn claim_codex_ticket(
    state: &UsageState,
    row: &PlannedRow,
    source: &str,
    request_id: &str,
    started_at_ms: i64,
    endpoints: &ResetEndpoints<'_>,
) -> ResetTicketOutcome {
    use ResetTicketOutcomeKind::*;
    let Ok(tokens) = credentials::codex_tokens(source) else {
        return ResetTicketOutcome::new(TokenStale);
    };
    if tokens.access_expires_at_ms.is_some_and(|expiry| expiry <= Utc::now().timestamp_millis()) {
        return ResetTicketOutcome::new(TokenStale);
    }
    if tokens.account_id.as_deref()
        .zip(row.identity_key.as_deref())
        .is_some_and(|(token, row)| token != row) {
        return ResetTicketOutcome::new(OwnerMismatch);
    }
    let identity = tokens.account_id
        .clone()
        .unwrap_or_else(|| format!("profile:{}", row.profile_id));
    let key = format!("codex:{identity}");
    let reuse = live_unsettled(state, &key, &identity).await;
    let request_id = reuse
        .as_ref()
        .map_or(request_id, |entry| entry.request_id.as_str());
    let mut outcome = claim_codex_verified(
        state, row, &tokens, &key, &identity, request_id,
        reuse.as_ref(), started_at_ms, endpoints,
    ).await;
    outcome.retry_of_unconfirmed = reuse.is_some();
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn claim_codex_verified(
    state: &UsageState,
    row: &PlannedRow,
    tokens: &credentials::CodexTokens,
    key: &str,
    identity: &str,
    request_id: &str,
    reuse: Option<&UnsettledReset>,
    started_at_ms: i64,
    endpoints: &ResetEndpoints<'_>,
) -> ResetTicketOutcome {
    let Some(claim_http) = state.reset_http.as_ref() else {
        return ResetTicketOutcome::new(ResetTicketOutcomeKind::Unavailable);
    };
    let remembered_url = state.codex_usage_urls.lock().await.get(&row.profile_id).cloned();
    let usage_url = endpoints.codex_usage_url.map(str::to_string)
        .or(remembered_url)
        .unwrap_or_else(|| oauth_codex::usage_urls().into_iter().next()
            .unwrap_or_else(|| "https://chatgpt.com/backend-api/wham/usage".into()));
    let cached = state.reset_credit_details.lock().await.get(&row.profile_id).cloned();
    let credit_id = if let Some(reuse) = reuse {
        reuse.target_id.clone()
    } else {
        let fetched = oauth_codex::fetch_credits_at(
            &state.http, &usage_url, &tokens.access_token, tokens.account_id.as_deref(),
        ).await;
        stale_reset_usage(state, &row.profile_id).await;
        let details = match fetched {
            Ok(credits) => {
                let entry = CachedCredits {
                    fetched_at_ms: Utc::now().timestamp_millis(),
                    available_count: credits.len() as u32,
                    credits,
                };
                state.reset_credit_details.lock().await
                    .insert(row.profile_id.clone(), entry.clone());
                Some(entry)
            }
            Err(_) => cached,
        };
        details.as_ref().and_then(|entry| reset_tickets::soonest_credit(&entry.credits))
            .map(|credit| credit.id.clone())
    };
    let outcome = oauth_codex::consume_at(claim_http, &usage_url, &tokens.access_token,
        tokens.account_id.as_deref(), request_id, credit_id.as_deref()).await;
    stale_reset_usage(state, &row.profile_id).await;
    if let Some(details) = state.reset_credit_details.lock().await.get_mut(&row.profile_id) {
        details.fetched_at_ms = 0;
    }
    settle_reset(state, key, identity, request_id, credit_id.as_deref(), reuse,
        started_at_ms, &outcome).await;
    outcome
}

#[tauri::command(async)]
pub async fn get_account_usage(
    app: tauri::AppHandle,
    state: tauri::State<'_, UsageState>,
) -> Result<AccountUsageReport, String> {
    let default_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let base = crate::test_profile::app_data_dir_from(default_dir);
    let accounts = crate::cli_accounts::list_resolved(&base)?;
    let rows = planned_rows(&accounts.profiles, &accounts.live);
    let priority = std::mem::take(&mut *state.deferred_priority.lock().await);
    let mut output = Vec::with_capacity(rows.len());
    let mut deferred_ids = Vec::new();
    let mut deferred_blank = 0usize;
    let mut budget = RoundBudget::default();
    let mut provider_rate_limited: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for index in processing_order(&rows, &priority) {
        let row = rows[index].clone();
        if let Some(owner) = &row.foreign_owner {
            state.profile_usage_cache.lock().await.remove(&row.profile_id);
            output.push((index, foreign_token_usage(&row, owner.email.clone(), true)));
            continue;
        }
        let now_ms = Utc::now().timestamp_millis();
        if let Some(cached) = cached_profile_windows(&state, &row.profile_id, now_ms).await {
            output.push((
                index,
                with_windows(profile_usage(&row, UsageRowState::Ok, None, None), cached),
            ));
            continue;
        }
        let cooldown_key = profile_cooldown_key(&row.profile_id);
        let provider_key = provider_cooldown_key(row.provider);
        let pause = match active_cooldown(&state, &provider_key, now_ms).await {
            Some(cooldown) => Some(cooldown),
            None => active_cooldown(&state, &cooldown_key, now_ms).await,
        };
        if let Some(cooldown) = pause {
            output.push((
                index,
                cooldown_usage(&state, &row, Some(rfc3339(cooldown.until_ms))).await,
            ));
            continue;
        }
        if row.provider == CliProvider::Codex && !row.is_active && refresh::codex_refresh_disabled()
        {
            output.push((
                index,
                profile_usage(
                    &row,
                    UsageRowState::Unsupported,
                    Some(ERROR_CODEX_UNSUPPORTED),
                    None,
                ),
            ));
            continue;
        }
        if row.provider == CliProvider::Grok && GROK_REFRESH_DISABLED.load(Ordering::Relaxed) {
            output.push((index, grok_refresh_stopped(&row).usage));
            continue;
        }
        if row.needs_relogin {
            output.push((
                index,
                profile_usage(
                    &row,
                    UsageRowState::NeedsRelogin,
                    Some(ERROR_NEEDS_RELOGIN),
                    None,
                ),
            ));
            continue;
        }
        if budget.exhausted(row.provider) {
            deferred_ids.push(row.profile_id.clone());
            let usage = deferred_usage(&state, &row, now_ms).await;
            if usage.state != UsageRowState::Ok {
                deferred_blank += 1;
            }
            output.push((index, usage));
            continue;
        }
        let source = token_source(&row, &base);
        let Ok(source) = source else {
            output.push((
                index,
                profile_usage(
                    &row,
                    UsageRowState::Error,
                    Some(ERROR_SNAPSHOT_UNAVAILABLE),
                    None,
                ),
            ));
            continue;
        };
        let fetch_count = budget.counter(row.provider);
        let result = match row.provider {
            CliProvider::Claude => {
                fetch_claude_profile(
                    &app,
                    &state,
                    &base,
                    &row,
                    &source,
                    &cooldown_key,
                    fetch_count,
                )
                .await
            }
            CliProvider::Codex => {
                fetch_codex_profile(
                    &app,
                    &state,
                    &base,
                    &row,
                    &source,
                    &cooldown_key,
                    fetch_count,
                )
                .await
            }
            CliProvider::Grok => {
                fetch_grok_profile(
                    &app,
                    &state,
                    &base,
                    &row,
                    &source,
                    &cooldown_key,
                    fetch_count,
                )
                .await
            }
        };
        if result.usage.state == UsageRowState::Cooldown {
            let seen = provider_rate_limited
                .entry(provider_key.clone())
                .or_insert(0);
            *seen += 1;
            if *seen >= PROVIDER_PAUSE_THRESHOLD {
                apply_429_cooldown(&state, &provider_key, Utc::now().timestamp_millis()).await;
            }
        }
        output.push((index, result.usage));
    }
    // Deferral is not a failure, so nothing else records it: this line is the
    // only way to see how often the budget runs short.
    if !deferred_ids.is_empty() {
        crate::usage::log_oauth_failure(
            &app,
            "get_account_usage_deferred",
            &format!(
                "deferred={} without_numbers={deferred_blank} spent={}",
                deferred_ids.len(),
                budget.summary()
            ),
        );
    }
    *state.deferred_priority.lock().await = deferred_ids;
    output.sort_by_key(|(index, _)| *index);
    Ok(AccountUsageReport {
        accounts: output.into_iter().map(|(_, usage)| usage).collect(),
        generated_at: Utc::now().to_rfc3339(),
    })
}

/// The order rows are *processed* in, distinct from the order they are
/// reported in. The account each CLI is logged into goes first: it is the one
/// being spent, its numbers drive the title bar and the auto-switch, and it
/// must never be the row the budget runs out on. Rows deferred last round come
/// next so the budget reaches them; everything else keeps its planned position.
fn processing_order(rows: &[PlannedRow], priority: &[String]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by_key(|&index| {
        if rows[index].is_active {
            return (0usize, 0usize, index);
        }
        match priority.iter().position(|id| id == &rows[index].profile_id) {
            Some(rank) => (1usize, rank, index),
            None => (2usize, 0usize, index),
        }
    });
    order
}

/// Requests spent this round, per provider. The ceiling exists for Anthropic's
/// per-IP rate limit, which chatgpt.com and Grok requests never touch, so each
/// provider counts its own. With one shared count, 15 accounts (9 Claude,
/// 5 Codex, 1 Grok on 2026-09-28) needed at least 15 requests a round against
/// a ceiling of 12, so every round deferred some rows.
#[derive(Default)]
struct RoundBudget {
    spent: [usize; 3],
}

impl RoundBudget {
    fn exhausted(&self, provider: CliProvider) -> bool {
        self.spent[provider_rank(provider) as usize] >= MAX_FETCH_PER_ROUND
    }

    fn counter(&mut self, provider: CliProvider) -> &mut usize {
        &mut self.spent[provider_rank(provider) as usize]
    }

    fn summary(&self) -> String {
        format!(
            "claude:{} codex:{} grok:{}",
            self.spent[0], self.spent[1], self.spent[2]
        )
    }
}

/// A row the round had no budget left for. It is served early next round;
/// until then it shows its last numbers, dated by their own fetch time exactly
/// as a cache hit is. It is blank only when it has none recent enough, or when
/// a spent reset ticket has made them wrong.
async fn deferred_usage(state: &UsageState, row: &PlannedRow, now_ms: i64) -> ProfileUsage {
    let recent = stale_profile_windows(state, &row.profile_id)
        .await
        .filter(|cached| {
            !cached.invalidated
                && now_ms.saturating_sub(cached.fetched_at_ms) < DEFERRED_STALE_MAX_MS
        });
    match recent {
        Some(windows) => with_windows(profile_usage(row, UsageRowState::Ok, None, None), windows),
        None => profile_usage(row, UsageRowState::Error, Some(ERROR_DEFERRED), None),
    }
}

struct FetchResult {
    usage: ProfileUsage,
}

/// Space out requests and charge one unit of the provider's round budget.
/// Called before every outbound request including refreshes, so a refreshing
/// row advances the counter more than once. Rows served from cache or held in
/// cooldown never reach here and cost nothing.
async fn stagger_before_fetch(fetch_count: &mut usize) {
    if *fetch_count > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    *fetch_count += 1;
}

#[derive(Debug, PartialEq, Eq)]
enum OwnerGate {
    Proceed,
    LiveForeign(TokenOwner),
    SnapshotForeign(TokenOwner),
    AsFailure(Option<u16>),
}

/// An older CLI can rewrite X's tokens without changing the name P. The name
/// alone cannot authorize showing X's usage on P's row.
fn claude_owner_gate(row_identity: Option<&str>, is_active: bool, registered: bool, check: &OwnerCheck) -> OwnerGate {
    match check {
        OwnerCheck::Owner(owner) if row_identity.is_none_or(|identity| identity == owner.account_uuid) => OwnerGate::Proceed,
        OwnerCheck::Owner(owner) if is_active || !registered => OwnerGate::LiveForeign(owner.clone()),
        OwnerCheck::Owner(owner) => OwnerGate::SnapshotForeign(owner.clone()),
        OwnerCheck::Rejected { status } => OwnerGate::AsFailure(Some(*status)),
        OwnerCheck::RateLimited { .. } => OwnerGate::AsFailure(Some(429)),
        OwnerCheck::Unavailable => OwnerGate::AsFailure(None),
    }
}

fn foreign_token_usage(row: &PlannedRow, email: Option<String>, snapshot: bool) -> ProfileUsage {
    let mut usage = profile_usage(row,
        if snapshot { UsageRowState::NeedsRelogin } else { UsageRowState::Error },
        Some(if snapshot { ERROR_FOREIGN_TOKEN } else { ERROR_LIVE_TOKEN_FOREIGN }), None);
    usage.needs_relogin |= snapshot;
    usage.token_owner_email = email;
    usage
}

async fn foreign_claude_usage(
    app: &tauri::AppHandle, state: &UsageState, base: &std::path::Path,
    row: &PlannedRow, owner: TokenOwner, snapshot: bool,
) -> FetchResult {
    state.profile_usage_cache.lock().await.remove(&row.profile_id);
    crate::usage::log_oauth_failure(app, "claude_token_owner_mismatch", &format!(
        "profile={} claimed={} owner={} active={}", row.profile_id,
        row.identity_key.as_deref().unwrap_or("").chars().take(8).collect::<String>(),
        owner.account_uuid.chars().take(8).collect::<String>(), !snapshot));
    if snapshot {
        let base = base.to_path_buf();
        let id = row.profile_id.clone();
        let saved_owner = owner.clone();
        let result = tokio::task::spawn_blocking(move ||
            crate::cli_accounts::record_foreign_token_owner(&base, &id, &saved_owner, Utc::now().to_rfc3339())).await;
        if !matches!(result, Ok(Ok(()))) {
            crate::usage::log_oauth_failure(app, "claude_token_owner_record",
                &format!("profile={} record_failed", row.profile_id));
        }
    }
    FetchResult { usage: foreign_token_usage(row, owner.email, snapshot) }
}

async fn fetch_claude_profile(
    app: &tauri::AppHandle,
    state: &UsageState,
    base: &std::path::Path,
    row: &PlannedRow,
    source: &str,
    cooldown_key: &str,
    fetch_count: &mut usize,
) -> FetchResult {
    let tokens = match credentials::claude_tokens(source) {
        Ok(tokens) => tokens,
        Err(_) => {
            return FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::Error,
                    Some(ERROR_SNAPSHOT_UNAVAILABLE),
                    None,
                ),
            }
        }
    };
    let now_ms = Utc::now().timestamp_millis();
    let mut refreshed_once = false;
    let mut access_token = match credentials::plan_token_source(
        row.is_active,
        Some(tokens.expires_at_ms),
        tokens.refresh_expires_at_ms,
        now_ms,
    ) {
        credentials::TokenPlan::UseLive | credentials::TokenPlan::UseSnapshot => {
            tokens.access_token.clone()
        }
        credentials::TokenPlan::WaitForCli => {
            return FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::WaitForCli,
                    Some(ERROR_TOKEN_EXPIRED_ACTIVE),
                    None,
                ),
            }
        }
        credentials::TokenPlan::NeedsRelogin => {
            return FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::NeedsRelogin,
                    Some(ERROR_NEEDS_RELOGIN),
                    None,
                ),
            }
        }
        credentials::TokenPlan::RefreshSnapshot => {
            refreshed_once = true;
            match refresh_claude_snapshot(app, state, base, row, &tokens, cooldown_key, fetch_count)
                .await
            {
                Ok(token) => token,
                Err(result) => return result,
            }
        }
    };
    loop {
        let check = match token_owner::cached_owner(&access_token) {
            Some(owner) => OwnerCheck::Owner(owner),
            None => {
                stagger_before_fetch(fetch_count).await;
                token_owner::claude_token_owner(&state.http, &access_token).await
            }
        };
        let (status, detail) = match claude_owner_gate(row.identity_key.as_deref(), row.is_active, row.registered, &check) {
            OwnerGate::Proceed => {
                stagger_before_fetch(fetch_count).await;
                match oauth_claude::fetch_with_token_status(&state.http, &access_token).await {
                    Ok(usage) => {
                        if let Some(reason) = usage.reset_status.as_ref().filter(|status| !status.eligible)
                            .and_then(|status| status.ineligible_reason.as_deref()) {
                            log_reset_ineligible_once(app, reason);
                        }
                        return successful_fetch(state, row, usage.five_hour, usage.seven_day,
                            usage.seven_day_sonnet, usage.seven_day_opus, usage.model_windows,
                            usage.reset_tickets, cooldown_key).await;
                    }
                    Err(error) => error,
                }
            }
            OwnerGate::LiveForeign(owner) => return foreign_claude_usage(app, state, base, row, owner, false).await,
            OwnerGate::SnapshotForeign(owner) => return foreign_claude_usage(app, state, base, row, owner, true).await,
            OwnerGate::AsFailure(status) => (status, match status {
                Some(status) => format!("Claude OAuth profile error: HTTP {status}"),
                None => "Claude OAuth profile network error".to_string(),
            }),
        };
        if !should_retry_claude_after_unauthorized(status, row.is_active, refreshed_once) {
            return usage_fetch_failure(app, state, row, cooldown_key, status, &detail).await;
        }
        refreshed_once = true;
        access_token = match refresh_claude_snapshot(
            app,
            state,
            base,
            row,
            &tokens,
            cooldown_key,
            fetch_count,
        )
        .await
        {
            Ok(token) => token,
            Err(result) => return result,
        };
    }
}

/// A Claude access token can be dead long before its printed expiry: the CLI
/// rotates the pair whenever it refreshes, and the server invalidates the old
/// access token with it. The clock-based plan cannot see that, so a 401/403
/// from the usage endpoint is the real signal. Refresh once and retry -- but
/// never for the account the CLI is logged into (the CLI will rotate it
/// itself), and never twice within one poll.
fn should_retry_claude_after_unauthorized(
    status: Option<u16>,
    is_active: bool,
    already_refreshed: bool,
) -> bool {
    matches!(status, Some(401) | Some(403)) && !is_active && !already_refreshed
}

fn log_reset_ineligible_once(app: &tauri::AppHandle, reason: &str) {
    if !matches!(reason, "surface" | "cli_version") { return; }
    static SEEN: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let seen = SEEN.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    if seen.lock().unwrap_or_else(|error| error.into_inner()).insert(reason.to_string()) {
        crate::usage::log_oauth_failure(app, "claude_reset_ticket_ineligible", &format!("reason={reason}"));
    }
}

/// An inactive name can still share the live CLI's refresh-token lineage.
fn shares_live_refresh_token(snapshot_refresh: &str, live_credentials: Option<&str>) -> bool {
    live_credentials.and_then(|text| credentials::claude_tokens(text).ok())
        .is_some_and(|tokens| tokens.refresh_token == snapshot_refresh)
}

/// Refresh an inactive Claude snapshot and persist the new tokens before use.
async fn refresh_claude_snapshot(
    app: &tauri::AppHandle,
    state: &UsageState,
    base: &std::path::Path,
    row: &PlannedRow,
    tokens: &credentials::ClaudeTokens,
    cooldown_key: &str,
    fetch_count: &mut usize,
) -> Result<String, FetchResult> {
    match live_identity_check(row) {
        LiveIdentityCheck::Active => {
            return Err(FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::WaitForCli,
                    Some(ERROR_TOKEN_EXPIRED_ACTIVE),
                    None,
                ),
            })
        }
        LiveIdentityCheck::Unknown => {
            return Err(FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::Error,
                    Some(ERROR_SNAPSHOT_UNAVAILABLE),
                    None,
                ),
            })
        }
        LiveIdentityCheck::Inactive => {}
    }
    // Filing X's live tokens into X's snapshot leaves X inactive by name but
    // sharing the CLI's refresh token. Rotating it here would log the terminal out.
    let live_credentials = ClaudePaths::resolve().ok().and_then(|paths| claude::read_credentials(&paths));
    if shares_live_refresh_token(&tokens.refresh_token, live_credentials.as_deref()) {
        return Err(FetchResult { usage: profile_usage(row, UsageRowState::WaitForCli,
            Some(ERROR_TOKEN_EXPIRED_ACTIVE), None) });
    }
    stagger_before_fetch(fetch_count).await;
    let refreshed = match refresh::refresh_claude(&state.http, &tokens.refresh_token).await {
        Ok(value) => value,
        Err(error) => return Err(refresh_failure(app, state, row, cooldown_key, error).await),
    };
    // A refresh preserves the owner of this refresh-token lineage.
    if let Some(owner) = token_owner::cached_owner(&tokens.access_token) {
        token_owner::remember_owner(&refreshed.access_token, &owner);
    }
    let next = credentials::ClaudeTokens {
        access_token: refreshed.access_token.clone(),
        refresh_token: refreshed
            .refresh_token
            .unwrap_or(tokens.refresh_token.clone()),
        expires_at_ms: refreshed.expires_at_ms,
        refresh_expires_at_ms: refreshed
            .refresh_expires_at_ms
            .or(tokens.refresh_expires_at_ms),
        subscription_type: tokens.subscription_type.clone(),
    };
    match write_snapshot(base, row, &tokens.refresh_token, move |text| {
        credentials::claude_credentials_with(text, &next)
    })
    .await
    {
        SnapshotWrite::Applied => Ok(refreshed.access_token),
        SnapshotWrite::Conflict => Err(FetchResult {
            usage: profile_usage(
                row,
                UsageRowState::Error,
                Some(ERROR_SNAPSHOT_CONFLICT),
                None,
            ),
        }),
        SnapshotWrite::Unavailable => Err(FetchResult {
            usage: profile_usage(
                row,
                UsageRowState::Error,
                Some(ERROR_SNAPSHOT_UNAVAILABLE),
                None,
            ),
        }),
    }
}

async fn fetch_codex_profile(
    app: &tauri::AppHandle,
    state: &UsageState,
    base: &std::path::Path,
    row: &PlannedRow,
    source: &str,
    cooldown_key: &str,
    fetch_count: &mut usize,
) -> FetchResult {
    let tokens = match credentials::codex_tokens(source) {
        Ok(tokens) => tokens,
        Err(_) => {
            return FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::Error,
                    Some(ERROR_SNAPSHOT_UNAVAILABLE),
                    None,
                ),
            }
        }
    };
    // auth.json carries no expiry, so this is usually None -- unknown, not
    // expired. plan_token_source then falls through to the token we already
    // hold, and a 401 from the usage endpoint is what actually triggers a
    // refresh. The second argument is None because Codex gives us no refresh
    // token expiry either.
    let plan = credentials::plan_token_source(
        row.is_active,
        tokens.access_expires_at_ms,
        None,
        Utc::now().timestamp_millis(),
    );
    let mut refreshed_once = false;
    let mut access_token = match plan {
        credentials::TokenPlan::WaitForCli => {
            return FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::WaitForCli,
                    Some(ERROR_TOKEN_EXPIRED_ACTIVE),
                    None,
                ),
            }
        }
        credentials::TokenPlan::NeedsRelogin => {
            return FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::NeedsRelogin,
                    Some(ERROR_NEEDS_RELOGIN),
                    None,
                ),
            }
        }
        credentials::TokenPlan::RefreshSnapshot => {
            let Some(old) = tokens.refresh_token.clone() else {
                return FetchResult {
                    usage: profile_usage(
                        row,
                        UsageRowState::NeedsRelogin,
                        Some(ERROR_NEEDS_RELOGIN),
                        None,
                    ),
                };
            };
            refreshed_once = true;
            match refresh_codex_snapshot(
                app,
                state,
                base,
                row,
                &tokens,
                &old,
                cooldown_key,
                fetch_count,
            )
            .await
            {
                Ok(token) => token,
                Err(result) => return result,
            }
        }
        credentials::TokenPlan::UseLive | credentials::TokenPlan::UseSnapshot => {
            tokens.access_token.clone()
        }
    };
    loop {
        stagger_before_fetch(fetch_count).await;
        let outcome =
            oauth_codex::fetch_with_token(&state.http, &access_token, tokens.account_id.as_deref())
                .await;
        let (status, detail) = match outcome {
            Ok(usage) => {
                state.codex_usage_urls.lock().await.insert(
                    row.profile_id.clone(), usage.usage_url.clone());
                let tickets = codex_reset_tickets(state, row, &usage, &access_token,
                    tokens.account_id.as_deref(), fetch_count).await;
                return successful_fetch(
                    state,
                    row,
                    usage.five_hour,
                    usage.seven_day,
                    None,
                    None,
                    Vec::new(),
                    tickets,
                    cooldown_key,
                )
                .await
            }
            Err(error) => error,
        };
        let retry = should_retry_codex_after_unauthorized(
            status,
            row.is_active,
            refreshed_once,
            tokens.refresh_token.is_some(),
            refresh::codex_refresh_disabled(),
        );
        let Some(old) = tokens.refresh_token.clone().filter(|_| retry) else {
            return usage_fetch_failure(app, state, row, cooldown_key, status, &detail).await;
        };
        refreshed_once = true;
        access_token = match refresh_codex_snapshot(
            app,
            state,
            base,
            row,
            &tokens,
            &old,
            cooldown_key,
            fetch_count,
        )
        .await
        {
            Ok(token) => token,
            Err(result) => return result,
        };
    }
}

async fn codex_reset_tickets(state: &UsageState, row: &PlannedRow, usage: &oauth_codex::CodexUsage,
    access_token: &str, account_id: Option<&str>, fetch_count: &mut usize) -> Option<ResetTickets> {
    let count = usage.reset_count?;
    if count == 0 {
        state.reset_credit_details.lock().await.remove(&row.profile_id);
        return Some(reset_tickets::codex_tickets(0, None));
    }
    let now = Utc::now().timestamp_millis();
    let cached = state.reset_credit_details.lock().await.get(&row.profile_id).cloned();
    let stale = cached.as_ref().is_none_or(|entry| entry.available_count != count
        || now.saturating_sub(entry.fetched_at_ms) >= 3_600_000);
    if stale && *fetch_count < MAX_FETCH_PER_ROUND {
        stagger_before_fetch(fetch_count).await;
        if let Ok(credits) = oauth_codex::fetch_credits_at(&state.http, &usage.usage_url, access_token, account_id).await {
            state.reset_credit_details.lock().await.insert(row.profile_id.clone(), CachedCredits {
                fetched_at_ms: now, available_count: count, credits,
            });
        }
    }
    let details = state.reset_credit_details.lock().await.get(&row.profile_id).cloned();
    Some(reset_tickets::codex_tickets(count, details.as_ref()))
}

/// A Codex access token whose expiry we cannot read is only provably dead once
/// the server says so. Refresh once on a 401/403 and retry -- but never for the
/// account the CLI is logged into, and never twice within one poll.
fn should_retry_codex_after_unauthorized(
    status: Option<u16>,
    is_active: bool,
    already_refreshed: bool,
    has_refresh_token: bool,
    refresh_disabled: bool,
) -> bool {
    matches!(status, Some(401) | Some(403))
        && !is_active
        && !already_refreshed
        && has_refresh_token
        && !refresh_disabled
}

async fn fetch_grok_profile(
    app: &tauri::AppHandle,
    state: &UsageState,
    base: &std::path::Path,
    row: &PlannedRow,
    source: &str,
    cooldown_key: &str,
    fetch_count: &mut usize,
) -> FetchResult {
    let tokens = match credentials::grok_tokens(source) {
        Ok(tokens) => tokens,
        Err(_) => return FetchResult { usage: profile_usage(row, UsageRowState::Error, Some(ERROR_SNAPSHOT_UNAVAILABLE), None) },
    };
    let mut refreshed_once = false;
    let mut access_token = tokens.access_token.clone();
    loop {
        stagger_before_fetch(fetch_count).await;
        match oauth_grok::fetch_with_token(&state.http, &access_token).await {
            Ok(usage) => return successful_fetch(
                state,
                row,
                None,
                usage.seven_day,
                None,
                None,
                usage.model_windows,
                None,
                cooldown_key,
            ).await,
            Err((status, detail)) => {
                let refresh_disabled = GROK_REFRESH_DISABLED.load(Ordering::Relaxed);
                if !should_retry_grok_after_unauthorized(status, refreshed_once, refresh_disabled) {
                    if refresh_disabled {
                        return grok_refresh_stopped(row);
                    }
                    return usage_fetch_failure(app, state, row, cooldown_key, status, &detail).await;
                }
                refreshed_once = true;
                access_token = match refresh_grok_snapshot(
                    app, state, base, row, &tokens, cooldown_key, fetch_count,
                ).await {
                    Ok(token) => token,
                    Err(result) => return result,
                };
            }
        }
    }
}

/// Unlike claude and codex -- whose CLIs are used daily and rotate their own
/// tokens -- grok's access token expires after a fixed six hours and its single
/// registered profile always matches the live login. Gating the retry on
/// `is_active`, as those two do, would mean grok never refreshed at all, so the
/// flag is deliberately not consulted here.
fn should_retry_grok_after_unauthorized(
    status: Option<u16>,
    already_refreshed: bool,
    refresh_disabled: bool,
) -> bool {
    matches!(status, Some(401) | Some(403)) && !already_refreshed && !refresh_disabled
}

fn grok_refresh_stopped(row: &PlannedRow) -> FetchResult {
    FetchResult {
        usage: profile_usage(row, UsageRowState::Unsupported, Some(ERROR_GROK_UNSUPPORTED), None),
    }
}

fn should_log_refresh_failure(
    provider: CliProvider,
    error: &refresh::RefreshError,
    grok_disabled: &AtomicBool,
) -> bool {
    if provider == CliProvider::Grok && matches!(error, refresh::RefreshError::Unsupported { .. }) {
        return !grok_disabled.swap(true, Ordering::Relaxed);
    }
    true
}

fn should_persist_grok_snapshot(new_refresh_token: Option<&str>) -> bool {
    new_refresh_token.is_some()
}

/// Where a refreshed grok token pair has to land to be read back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GrokTokenDestination {
    /// The live `auth.json`: an active row's tokens are read from there, and
    /// the CLI shares the file.
    LiveAuth,
    /// The account snapshot, which is what an inactive registered row reads.
    Snapshot,
}

/// Mirrors how `get_account_usage` picks the text it reads the tokens *from*,
/// so a refreshed pair always lands in the file the next round will read.
fn grok_token_destination(is_active: bool, registered: bool) -> GrokTokenDestination {
    if is_active || !registered {
        GrokTokenDestination::LiveAuth
    } else {
        GrokTokenDestination::Snapshot
    }
}

async fn refresh_grok_snapshot(
    app: &tauri::AppHandle,
    state: &UsageState,
    base: &std::path::Path,
    row: &PlannedRow,
    tokens: &credentials::GrokTokens,
    cooldown_key: &str,
    fetch_count: &mut usize,
) -> Result<String, FetchResult> {
    let _refresh_guard = GROK_REFRESH_LOCK.lock().await;
    if GROK_REFRESH_DISABLED.load(Ordering::Relaxed) {
        return Err(grok_refresh_stopped(row));
    }
    match live_identity_check(row) {
        LiveIdentityCheck::Active | LiveIdentityCheck::Inactive => {}
        LiveIdentityCheck::Unknown => return Err(FetchResult { usage: profile_usage(row, UsageRowState::Error, Some(ERROR_SNAPSHOT_UNAVAILABLE), None) }),
    }
    stagger_before_fetch(fetch_count).await;
    let refreshed = match refresh::refresh_grok(&state.http, &tokens.refresh_token, &tokens.client_id).await {
        Ok(value) => value,
        Err(error) => return Err(refresh_failure(app, state, row, cooldown_key, error).await),
    };
    // Nothing rotated: the token on disk is still the one to refresh from next
    // time, so there is nothing to write and the fresh access token answers
    // this round from memory.
    if !should_persist_grok_snapshot(refreshed.refresh_token.as_deref()) {
        return Ok(refreshed.access_token);
    }
    match grok_token_destination(row.is_active, row.registered) {
        GrokTokenDestination::LiveAuth => {
            write_grok_live_tokens(&tokens.refresh_token, &refreshed).await;
            Ok(refreshed.access_token)
        }
        GrokTokenDestination::Snapshot => {
            let next_access = refreshed.access_token.clone();
            let next_refresh = refreshed.refresh_token.clone();
            match write_snapshot(base, row, &tokens.refresh_token, move |text| {
                credentials::grok_auth_with(text, &next_access, next_refresh.as_deref())
            }).await {
                SnapshotWrite::Applied | SnapshotWrite::Conflict => Ok(refreshed.access_token),
                SnapshotWrite::Unavailable => Err(FetchResult { usage: profile_usage(row, UsageRowState::Error, Some(ERROR_SNAPSHOT_UNAVAILABLE), None) }),
            }
        }
    }
}

/// Best-effort write of a rotated pair into the CLI's own `auth.json`.
///
/// Failure here is not failure of the fetch: the access token is already in
/// hand and answers this round either way. Losing the write only means the next
/// round refreshes again, which is what happened before this path existed.
async fn write_grok_live_tokens(
    expected_refresh_token: &str,
    refreshed: &refresh::RefreshedGrok,
) {
    let expected = expected_refresh_token.to_string();
    let access = refreshed.access_token.clone();
    let next_refresh = refreshed.refresh_token.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let paths = GrokPaths::resolve()?;
        grok::update_live_tokens(&paths, &expected, &access, next_refresh.as_deref())
    })
    .await;
    match outcome {
        Ok(Ok(grok::LiveTokenWrite::Applied)) => {}
        Ok(Ok(grok::LiveTokenWrite::Conflict)) => {
            eprintln!("[usage] grok auth.json rotated by the CLI first; keeping its tokens");
        }
        Ok(Err(error)) => eprintln!("[usage] grok auth.json update skipped: {error}"),
        Err(error) => eprintln!("[usage] grok auth.json update panicked: {error}"),
    }
}

/// Refresh an inactive Codex snapshot and persist the new tokens before using
/// them. Returns the fresh access token, or the FetchResult the caller should
/// return as-is.
#[allow(clippy::too_many_arguments)]
async fn refresh_codex_snapshot(
    app: &tauri::AppHandle,
    state: &UsageState,
    base: &std::path::Path,
    row: &PlannedRow,
    tokens: &credentials::CodexTokens,
    old_refresh_token: &str,
    cooldown_key: &str,
    fetch_count: &mut usize,
) -> Result<String, FetchResult> {
    match live_identity_check(row) {
        LiveIdentityCheck::Active => {
            return Err(FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::WaitForCli,
                    Some(ERROR_TOKEN_EXPIRED_ACTIVE),
                    None,
                ),
            })
        }
        LiveIdentityCheck::Unknown => {
            return Err(FetchResult {
                usage: profile_usage(
                    row,
                    UsageRowState::Error,
                    Some(ERROR_SNAPSHOT_UNAVAILABLE),
                    None,
                ),
            })
        }
        LiveIdentityCheck::Inactive => {}
    }
    stagger_before_fetch(fetch_count).await;
    let refreshed = match refresh::refresh_codex(&state.http, old_refresh_token).await {
        Ok(value) => value,
        Err(error) => return Err(refresh_failure(app, state, row, cooldown_key, error).await),
    };
    let next = credentials::CodexTokens {
        access_token: refreshed.access_token.clone(),
        refresh_token: refreshed
            .refresh_token
            .clone()
            .or_else(|| Some(old_refresh_token.to_string())),
        account_id: tokens.account_id.clone(),
        id_token: refreshed
            .id_token
            .clone()
            .or_else(|| tokens.id_token.clone()),
        // Not written back: auth.json has no field for it.
        access_expires_at_ms: None,
    };
    let stamp = Utc::now().to_rfc3339();
    match write_snapshot(base, row, old_refresh_token, move |text| {
        credentials::codex_auth_with(text, &next, Some(&stamp))
    })
    .await
    {
        SnapshotWrite::Applied => Ok(refreshed.access_token),
        SnapshotWrite::Conflict => Err(FetchResult {
            usage: profile_usage(
                row,
                UsageRowState::Error,
                Some(ERROR_SNAPSHOT_CONFLICT),
                None,
            ),
        }),
        SnapshotWrite::Unavailable => Err(FetchResult {
            usage: profile_usage(
                row,
                UsageRowState::Error,
                Some(ERROR_SNAPSHOT_UNAVAILABLE),
                None,
            ),
        }),
    }
}

/// Re-read the live login right before refreshing, in case a switch landed
/// while this poll was in flight.
enum LiveIdentityCheck {
    /// The CLI is logged into this very account. Refreshing would race it for
    /// the same refresh token.
    Active,
    /// A different account, or none at all, is logged in. Safe to refresh.
    Inactive,
    /// The live files could not be read, or name nobody. Refuse to refresh:
    /// guessing "inactive" and being wrong logs the user out of their terminal,
    /// while guessing "active" only costs one poll's worth of numbers.
    Unknown,
}

fn live_identity_check(row: &PlannedRow) -> LiveIdentityCheck {
    let live = match row.provider {
        CliProvider::Claude => {
            ClaudePaths::resolve().map(|paths| claude::read_live_identity(&paths))
        }
        CliProvider::Codex => CodexPaths::resolve().map(|paths| codex::read_live_identity(&paths)),
        CliProvider::Grok => GrokPaths::resolve().map(|paths| grok::read_live_identity(&paths)),
    };
    classify_live_identity(live.as_ref().ok(), row.identity_key.as_deref())
}

/// `live` is None when the paths could not even be resolved.
fn classify_live_identity(
    live: Option<&CliLiveLogin>,
    row_identity: Option<&str>,
) -> LiveIdentityCheck {
    let Some(live) = live else {
        return LiveIdentityCheck::Unknown;
    };
    if live.error.is_some() {
        return LiveIdentityCheck::Unknown;
    }
    if !live.present {
        return LiveIdentityCheck::Inactive;
    }
    match (live.identity_key.as_deref(), row_identity) {
        (Some(live_key), Some(row_key)) if live_key == row_key => LiveIdentityCheck::Active,
        (Some(_), Some(_)) => LiveIdentityCheck::Inactive,
        // Somebody is logged in but one of the two sides cannot be named. Do not
        // guess: an "inactive" verdict here would let us refresh the live token.
        _ => LiveIdentityCheck::Unknown,
    }
}

enum SnapshotWrite {
    Applied,
    Conflict,
    Unavailable,
}

async fn write_snapshot<F>(
    base: &std::path::Path,
    row: &PlannedRow,
    expected_refresh_token: &str,
    rewrite: F,
) -> SnapshotWrite
where
    F: FnOnce(&str) -> Result<String, String> + Send + 'static,
{
    let base = base.to_path_buf();
    let profile_id = row.profile_id.clone();
    let provider = row.provider;
    let expected = expected_refresh_token.to_string();
    match tokio::task::spawn_blocking(move || {
        crate::cli_accounts::update_snapshot_tokens(
            &base,
            &profile_id,
            provider,
            &expected,
            rewrite,
        )
    })
    .await
    {
        Ok(Ok(SnapshotUpdate::Applied)) => SnapshotWrite::Applied,
        Ok(Ok(SnapshotUpdate::Conflict)) => SnapshotWrite::Conflict,
        Ok(Ok(SnapshotUpdate::NotFound)) | Ok(Err(_)) | Err(_) => SnapshotWrite::Unavailable,
    }
}

#[allow(clippy::too_many_arguments)]
async fn successful_fetch(
    state: &UsageState,
    row: &PlannedRow,
    five_hour: Option<crate::usage::WindowStat>,
    seven_day: Option<crate::usage::WindowStat>,
    seven_day_sonnet: Option<crate::usage::WindowStat>,
    seven_day_opus: Option<crate::usage::WindowStat>,
    model_windows: Vec<crate::usage::NamedWindow>,
    reset_tickets: Option<ResetTickets>,
    cooldown_key: &str,
) -> FetchResult {
    let fetched_at_ms = Utc::now().timestamp_millis();
    let windows = CachedWindows {
        five_hour,
        seven_day,
        seven_day_sonnet,
        seven_day_opus,
        model_windows,
        reset_tickets,
        fetched_at_ms,
        invalidated: false,
    };
    state
        .profile_usage_cache
        .lock()
        .await
        .insert(row.profile_id.clone(), windows.clone());
    // A success also clears the provider-wide pause: it proves this address is
    // not rate-limited right now, so the doubled backoff a past 429 left
    // behind must not outlive the condition it measured.
    let mut cooldowns = state.cooldowns.lock().await;
    cooldowns.remove(cooldown_key);
    cooldowns.remove(&provider_cooldown_key(row.provider));
    drop(cooldowns);
    FetchResult {
        usage: with_windows(profile_usage(row, UsageRowState::Ok, None, None), windows),
    }
}

async fn usage_fetch_failure(
    app: &tauri::AppHandle,
    state: &UsageState,
    row: &PlannedRow,
    cooldown_key: &str,
    status: Option<u16>,
    detail: &str,
) -> FetchResult {
    crate::usage::log_oauth_failure(app, "get_account_usage", detail);
    if status == Some(429) {
        apply_429_cooldown(state, cooldown_key, Utc::now().timestamp_millis()).await;
        let retry_at = active_cooldown(state, cooldown_key, Utc::now().timestamp_millis())
            .await
            .map(|cooldown| rfc3339(cooldown.until_ms));
        return FetchResult {
            usage: cooldown_usage(state, row, retry_at).await,
        };
    }
    FetchResult {
        usage: profile_usage(
            row,
            UsageRowState::Error,
            Some(if status.is_none() {
                ERROR_NETWORK
            } else {
                ERROR_UPSTREAM
            }),
            None,
        ),
    }
}

/// Re-capture the live CLI login into this row's snapshot, but only when the
/// live login *is* this account. Returns whether the snapshot was replaced.
///
/// The refresh plan is made before the request goes out, so an account that was
/// inactive then can be live by the time the answer comes back. In that window
/// the stored copy is simply older than the file on disk, and the recovery is
/// to take the file — not to tell the user to log in again.
async fn recapture_live_snapshot(app: &tauri::AppHandle, row: &PlannedRow) -> bool {
    if !matches!(live_identity_check(row), LiveIdentityCheck::Active) {
        return false;
    }
    if row.provider == CliProvider::Claude {
        let Some(token) = ClaudePaths::resolve().ok()
            .and_then(|paths| claude::read_credentials(&paths))
            .and_then(|text| token_owner::claude_access_token(&text)) else { return false };
        let state = app.state::<UsageState>();
        match token_owner::claude_token_owner(&state.http, &token).await {
            OwnerCheck::Owner(owner) if row.identity_key.as_deref() == Some(owner.account_uuid.as_str()) => {}
            _ => return false,
        }
    }
    // Codex/Grok already store name and token together; their recapture is unchanged.
    let Ok(default_dir) = app.path().app_data_dir() else {
        return false;
    };
    let base = crate::test_profile::app_data_dir_from(default_dir);
    let provider = row.provider;
    matches!(
        tokio::task::spawn_blocking(move || crate::cli_accounts::capture_resolved(
            &base, provider, None
        ))
        .await,
        Ok(Ok(_))
    )
}

async fn remember_refresh_rejection(app: &tauri::AppHandle, row: &PlannedRow) {
    let Ok(default_dir) = app.path().app_data_dir() else {
        crate::usage::log_oauth_failure(
            app,
            "get_account_usage_refresh_record",
            &format!("profile={} app_data_dir_unavailable", row.profile_id),
        );
        return;
    };
    let base = crate::test_profile::app_data_dir_from(default_dir);
    let profile_id = row.profile_id.clone();
    let rejected_at = Utc::now().to_rfc3339();
    let result = tokio::task::spawn_blocking(move || {
        crate::cli_accounts::record_refresh_rejection(&base, &profile_id, rejected_at)
    })
    .await;
    if let Err(error) = result.unwrap_or_else(|error| Err(error.to_string())) {
        crate::usage::log_oauth_failure(
            app,
            "get_account_usage_refresh_record",
            &format!("profile={} {error}", row.profile_id),
        );
    }
}

async fn refresh_failure(
    app: &tauri::AppHandle,
    state: &UsageState,
    row: &PlannedRow,
    cooldown_key: &str,
    error: refresh::RefreshError,
) -> FetchResult {
    // Name the row: without it the log says only that "a refresh was refused",
    // which is true of a stale snapshot, a token the CLI rotated, and a wrong
    // client id alike. profile_id is an internal handle, never an address.
    if should_log_refresh_failure(row.provider, &error, &GROK_REFRESH_DISABLED) {
        let stopped = if row.provider == CliProvider::Grok
            && matches!(error, refresh::RefreshError::Unsupported { .. })
        {
            " automatic_refresh_disabled_until_restart=true"
        } else {
            ""
        };
        crate::usage::log_oauth_failure(
            app,
            "get_account_usage_refresh",
            &format!(
                "provider={:?} profile={} active={} {error:?}{stopped}",
                row.provider, row.profile_id, row.is_active
            ),
        );
    }
    match error {
        refresh::RefreshError::Rejected { .. } => {
            // A rejected refresh usually means the provider rotated this token
            // away while the CLI held the account, and only a human re-login
            // can fix that. But the account can also have gone live between the
            // plan and the request, in which case the live file is the newer
            // copy and re-capturing it costs nothing: park the row for one
            // cycle instead of stranding it at "needs re-login" forever.
            if recapture_live_snapshot(app, row).await {
                return FetchResult {
                    usage: profile_usage(
                        row,
                        UsageRowState::WaitForCli,
                        Some(ERROR_TOKEN_EXPIRED_ACTIVE),
                        None,
                    ),
                };
            }
            remember_refresh_rejection(app, row).await;
            // A user can finish re-login after the first live check but before
            // the registry write. Re-capture once more so that race cannot put
            // a stale rejection marker back onto freshly captured tokens.
            if recapture_live_snapshot(app, row).await {
                return FetchResult {
                    usage: profile_usage(
                        row,
                        UsageRowState::WaitForCli,
                        Some(ERROR_TOKEN_EXPIRED_ACTIVE),
                        None,
                    ),
                };
            }
            let mut relogin_row = row.clone();
            relogin_row.needs_relogin = true;
            FetchResult {
                usage: profile_usage(
                    &relogin_row,
                    UsageRowState::NeedsRelogin,
                    Some(ERROR_NEEDS_RELOGIN),
                    None,
                ),
            }
        }
        refresh::RefreshError::Unsupported { .. } => FetchResult {
            usage: profile_usage(
                row,
                UsageRowState::Unsupported,
                Some(if row.provider == CliProvider::Grok {
                    ERROR_GROK_UNSUPPORTED
                } else {
                    ERROR_CODEX_UNSUPPORTED
                }),
                None,
            ),
        },
        refresh::RefreshError::RateLimited { retry_after_secs } => {
            let now_ms = Utc::now().timestamp_millis();
            apply_429_cooldown(state, cooldown_key, now_ms).await;
            if let Some(seconds) = retry_after_secs {
                if let Some(cooldown) = state.cooldowns.lock().await.get_mut(cooldown_key) {
                    cooldown.until_ms = cooldown
                        .until_ms
                        .max(now_ms.saturating_add((seconds as i64).saturating_mul(1000)));
                }
            }
            let retry_at = active_cooldown(state, cooldown_key, now_ms)
                .await
                .map(|cooldown| rfc3339(cooldown.until_ms));
            FetchResult {
                usage: cooldown_usage(state, row, retry_at).await,
            }
        }
        refresh::RefreshError::Network => FetchResult {
            usage: profile_usage(row, UsageRowState::Error, Some(ERROR_NETWORK), None),
        },
        refresh::RefreshError::Transient(_) => FetchResult {
            usage: profile_usage(row, UsageRowState::Error, Some(ERROR_UPSTREAM), None),
        },
    }
}

pub(crate) async fn apply_429_cooldown(state: &UsageState, account_id: &str, now_ms: i64) {
    let mut cooldowns = state.cooldowns.lock().await;
    let backoff_ms = cooldowns
        .get(account_id)
        .map(|cooldown| cooldown.backoff_ms.saturating_mul(2).min(COOLDOWN_MAX_MS))
        .unwrap_or(COOLDOWN_BASE_MS);
    cooldowns.insert(
        account_id.to_string(),
        Cooldown {
            until_ms: now_ms.saturating_add(backoff_ms),
            backoff_ms,
        },
    );
}

async fn active_cooldown(state: &UsageState, account_id: &str, now_ms: i64) -> Option<Cooldown> {
    state
        .cooldowns
        .lock()
        .await
        .get(account_id)
        .copied()
        .filter(|cooldown| now_ms < cooldown.until_ms)
}

fn rfc3339(timestamp_ms: i64) -> String {
    chrono::DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .map(|timestamp| timestamp.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset_row(provider: CliProvider) -> PlannedRow {
        PlannedRow {
            profile_id: "reset-profile".into(), provider,
            label: "Reset test".into(), email: Some("owner@example.test".into()),
            plan: None, identity_key: Some(if provider == CliProvider::Claude {
                "account-a".into()
            } else {
                "acct-a".into()
            }),
            registered: true, is_active: false, needs_relogin: false,
            foreign_owner: None,
        }
    }

    fn claude_source(token: &str) -> String {
        serde_json::json!({"claudeAiOauth": {
            "accessToken": token, "refreshToken": "synthetic-refresh",
            "expiresAt": 4102444800000_i64
        }}).to_string()
    }

    fn codex_source() -> String {
        serde_json::json!({"tokens": {
            "access_token": "synthetic-codex", "account_id": "acct-a"
        }}).to_string()
    }

    fn claude_status(grant: &str, extra: serde_json::Value) -> String {
        let mut block = serde_json::json!({
            "eligible": true, "at_limit": false,
            "grants": [{"id": grant, "resets_left": 1,
                "usable_now": true, "use_requires_limit": false}],
            "next_grant_id": grant,
        });
        for (key, value) in extra.as_object().unwrap() {
            block[key] = value.clone();
        }
        serde_json::json!({"cedar_ember": block}).to_string()
    }

    fn endpoints<'a>(base: &'a str, profile: &'a str, usage: &'a str,
        codex_usage: Option<&'a str>) -> ResetEndpoints<'a> {
        ResetEndpoints { claude_base: base, claude_profile_url: profile,
            claude_usage_url: usage, codex_usage_url: codex_usage }
    }

    fn owner_body(org: &str) -> String {
        owner_body_for("account-a", org)
    }

    fn owner_body_for(account: &str, org: &str) -> String {
        serde_json::json!({"account": {"uuid": account},
            "organization": {"uuid": org}}).to_string()
    }

    fn request_body(request: &str) -> serde_json::Value {
        serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn claude_reset_happy_path_and_exact_body() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, owner_body("org-a")),
            (200, claude_status("grant-a", serde_json::json!({}))),
            (200, r#"{"result":"reset","resets_left":0}"#.into()),
        ]).await;
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let state = UsageState::new();
        let result = use_reset_ticket_inner(&state, &reset_row(CliProvider::Claude),
            Ok(claude_source("happy-token")), "request-a", Some("OWNER@EXAMPLE.TEST"),
            &endpoints(&base, &profile, &usage, None)).await.unwrap();
        assert_eq!(result.kind, ResetTicketOutcomeKind::Reset);
        assert!(!result.retry_of_unconfirmed);
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("GET /profile "));
        assert!(requests[1].starts_with("GET /usage "));
        assert!(requests[2].starts_with("POST /api/organizations/org-a/reset_rate_limits "));
        assert_eq!(request_body(&requests[2]), serde_json::json!({
            "program": "cedar_ember", "grant_id": "grant-a", "request_id": "request-a"
        }));
    }

    #[tokio::test]
    async fn claude_checks_stop_before_post() {
        use ResetTicketOutcomeKind::*;
        let cases = [
            ("foreign", owner_body("org-a").replace("account-a", "other"),
                claude_status("grant-a", serde_json::json!({})), OwnerMismatch, 1),
            ("invalid-org", owner_body("org/../x"),
                claude_status("grant-a", serde_json::json!({})), Unavailable, 1),
            ("no-grant", owner_body("org-a"),
                claude_status("grant-a", serde_json::json!({"grants": []})), NoTicket, 2),
            ("cooldown", owner_body("org-a"),
                claude_status("grant-a", serde_json::json!({
                    "cooldown_until": "2099-01-01T00:00:00Z"
                })), Cooldown, 2),
            ("requires", owner_body("org-a"),
                claude_status("grant-a", serde_json::json!({"grants": [{
                    "id": "grant-a", "resets_left": 1,
                    "usable_now": false, "use_requires_limit": true
                }]})), NothingToReset, 2),
        ];
        for (name, owner, usage_body, expected, count) in cases {
            let responses = if count == 1 { vec![(200, owner)] }
                else { vec![(200, owner), (200, usage_body)] };
            let (base, received) = reset_tickets::fake_http_sequence(responses).await;
            let profile = format!("{base}/profile");
            let usage = format!("{base}/usage");
            let state = UsageState::new();
            let result = use_reset_ticket_inner(&state, &reset_row(CliProvider::Claude),
                Ok(claude_source(name)), "request-a", None,
                &endpoints(&base, &profile, &usage, None)).await.unwrap();
            assert_eq!(result.kind, expected, "{name}");
            let requests = received.await.unwrap();
            assert_eq!(requests.len(), count, "{name}");
            assert!(requests.iter().all(|request| !request.starts_with("POST")));
        }
    }

    #[tokio::test]
    async fn claude_unconfirmed_reuses_key_and_clears_on_reset() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, owner_body("org-a")),
            (200, claude_status("grant-a", serde_json::json!({}))),
            (500, "{}".into()),
            (200, claude_status("grant-a", serde_json::json!({}))),
            (200, r#"{"result":"reset"}"#.into()),
        ]).await;
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let state = UsageState::new();
        let row = reset_row(CliProvider::Claude);
        let urls = endpoints(&base, &profile, &usage, None);
        let first = use_reset_ticket_inner(&state, &row, Ok(claude_source("retry-token")),
            "first-id", None, &urls).await.unwrap();
        assert_eq!(first.kind, ResetTicketOutcomeKind::Unconfirmed);
        assert_eq!(
            state.reset_unsettled.lock().await.get("claude:account-a")
                .unwrap().target_id.as_deref(),
            Some("grant-a"),
        );
        state.reset_unsettled.lock().await
            .get_mut("claude:account-a").unwrap().started_at_ms =
            Utc::now().timestamp_millis() + 60_000;
        let second = use_reset_ticket_inner(&state, &row, Ok(claude_source("retry-token")),
            "second-id", None, &urls).await.unwrap();
        assert_eq!(second.kind, ResetTicketOutcomeKind::Reset);
        assert!(second.retry_of_unconfirmed);
        assert!(state.reset_unsettled.lock().await.get("claude:account-a").is_none());
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 5);
        assert_eq!(request_body(&requests[2])["request_id"], "first-id");
        assert_eq!(request_body(&requests[4])["request_id"], "first-id");
        assert_eq!(request_body(&requests[4])["grant_id"], "grant-a");
    }

    #[tokio::test]
    async fn claude_reuse_different_grant_and_cooldown() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, owner_body("org-a")),
            (200, claude_status("grant-a", serde_json::json!({
                "cooldown_until": "2099-01-01T00:00:00Z"
            }))),
            (200, claude_status("grant-b", serde_json::json!({}))),
        ]).await;
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let state = UsageState::new();
        let row = reset_row(CliProvider::Claude);
        state.reset_unsettled.lock().await.insert("claude:account-a".into(), UnsettledReset {
            identity: "account-a".into(),
            request_id: "first-id".into(), target_id: Some("grant-a".into()),
            started_at_ms: Utc::now().timestamp_millis(),
        });
        let urls = endpoints(&base, &profile, &usage, None);
        let cooldown = use_reset_ticket_inner(&state, &row, Ok(claude_source("different-token")),
            "second-id", None, &urls).await.unwrap();
        assert_eq!(cooldown.kind, ResetTicketOutcomeKind::Cooldown);
        assert!(cooldown.retry_of_unconfirmed);
        assert!(state.reset_unsettled.lock().await.contains_key("claude:account-a"));
        let settled = use_reset_ticket_inner(&state, &row, Ok(claude_source("different-token")),
            "third-id", None, &urls).await.unwrap();
        assert_eq!(settled.kind, ResetTicketOutcomeKind::OfferChanged);
        assert!(settled.retry_of_unconfirmed);
        assert!(state.reset_unsettled.lock().await.is_empty());
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests.iter().all(|request| !request.starts_with("POST")));
    }

    #[tokio::test]
    async fn claude_no_remaining_tickets_clears_unsettled_without_post() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, owner_body("org-a")),
            (200, claude_status("grant-a", serde_json::json!({"grants": []}))),
        ]).await;
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let state = UsageState::new();
        let row = reset_row(CliProvider::Claude);
        state.reset_unsettled.lock().await.insert("claude:account-a".into(), UnsettledReset {
            identity: "account-a".into(),
            request_id: "original-id".into(), target_id: Some("grant-a".into()),
            started_at_ms: Utc::now().timestamp_millis(),
        });
        let outcome = use_reset_ticket_inner(&state, &row,
            Ok(claude_source("no-remaining-token")), "fresh-id", None,
            &endpoints(&base, &profile, &usage, None)).await.unwrap();
        assert_eq!(outcome.kind, ResetTicketOutcomeKind::NoTicket);
        assert!(outcome.retry_of_unconfirmed);
        assert!(state.reset_unsettled.lock().await.is_empty());
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|request| !request.starts_with("POST")));
    }

    #[tokio::test]
    async fn claude_unknown_precheck_keeps_unsettled_without_post() {
        let cases = [
            ("missing", serde_json::json!({"cedar_ember": null})),
            ("unavailable", serde_json::json!({"cedar_ember": {
                "eligible": false, "ineligible_reason": "unavailable"
            }})),
        ];
        for (name, body) in cases {
            let (base, received) = reset_tickets::fake_http_sequence(vec![
                (200, owner_body("org-a")),
                (200, body.to_string()),
            ]).await;
            let profile = format!("{base}/profile");
            let usage = format!("{base}/usage");
            let state = UsageState::new();
            let row = reset_row(CliProvider::Claude);
            let original = UnsettledReset {
                identity: "account-a".into(), request_id: "original-id".into(),
                target_id: Some("grant-a".into()),
                started_at_ms: Utc::now().timestamp_millis(),
            };
            state.reset_unsettled.lock().await.insert(
                "claude:account-a".into(), original.clone(),
            );
            let outcome = use_reset_ticket_inner(
                &state, &row, Ok(claude_source(&format!("unknown-{name}"))),
                "fresh-id", None, &endpoints(&base, &profile, &usage, None),
            ).await.unwrap();
            assert_eq!(outcome.kind, ResetTicketOutcomeKind::Unavailable, "{name}");
            assert!(outcome.retry_of_unconfirmed);
            assert_eq!(state.reset_unsettled.lock().await.get("claude:account-a"), Some(&original));
            let requests = received.await.unwrap();
            assert_eq!(requests.len(), 2);
            assert!(requests.iter().all(|request| !request.starts_with("POST")));
        }
    }

    #[tokio::test]
    async fn live_claude_account_change_does_not_reuse_another_identity() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, owner_body_for("account-x", "org-a")),
            (200, claude_status("grant-a", serde_json::json!({}))),
            (500, "{}".into()),
            (200, owner_body_for("account-y", "org-a")),
            (200, claude_status("grant-b", serde_json::json!({}))),
            (200, r#"{"result":"reset"}"#.into()),
        ]).await;
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let urls = endpoints(&base, &profile, &usage, None);
        let state = UsageState::new();
        let mut row = reset_row(CliProvider::Claude);
        row.profile_id = "live:claude".into();
        row.identity_key = None;
        row.registered = false;
        let first = use_reset_ticket_inner(
            &state, &row, Ok(claude_source("live-account-x")),
            "first-id", None, &urls,
        ).await.unwrap();
        assert_eq!(first.kind, ResetTicketOutcomeKind::Unconfirmed);
        assert!(state.reset_unsettled.lock().await.contains_key("claude:account-x"));
        let second = use_reset_ticket_inner(
            &state, &row, Ok(claude_source("live-account-y")),
            "second-id", None, &urls,
        ).await.unwrap();
        assert_eq!(second.kind, ResetTicketOutcomeKind::Reset);
        assert!(!second.retry_of_unconfirmed);
        assert!(state.reset_unsettled.lock().await.contains_key("claude:account-x"));
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 6);
        assert_eq!(request_body(&requests[2])["request_id"], "first-id");
        assert_eq!(request_body(&requests[5])["request_id"], "second-id");
    }

    #[tokio::test]
    async fn registered_claude_row_reuses_the_live_accounts_attempt() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, owner_body("org-a")),
            (200, claude_status("grant-a", serde_json::json!({}))),
            (500, "{}".into()),
            (200, claude_status("grant-a", serde_json::json!({}))),
            (200, r#"{"result":"reset"}"#.into()),
        ]).await;
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let urls = endpoints(&base, &profile, &usage, None);
        let state = UsageState::new();
        let mut row = reset_row(CliProvider::Claude);
        row.profile_id = "live:claude".into();
        row.identity_key = None;
        row.registered = false;
        let first = use_reset_ticket_inner(
            &state, &row, Ok(claude_source("register-token")),
            "first-id", None, &urls,
        ).await.unwrap();
        assert_eq!(first.kind, ResetTicketOutcomeKind::Unconfirmed);
        row.profile_id = "registered-x".into();
        row.identity_key = Some("account-a".into());
        row.registered = true;
        let second = use_reset_ticket_inner(
            &state, &row, Ok(claude_source("register-token")),
            "second-id", None, &urls,
        ).await.unwrap();
        assert_eq!(second.kind, ResetTicketOutcomeKind::Reset);
        assert!(second.retry_of_unconfirmed);
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 5);
        assert_eq!(request_body(&requests[4])["request_id"], "first-id");
    }

    #[tokio::test]
    async fn future_unsettled_time_is_live_and_mismatched_identity_is_ignored() {
        let state = UsageState::new();
        let original = UnsettledReset {
            identity: "account-a".into(), request_id: "first-id".into(),
            target_id: Some("grant-a".into()),
            started_at_ms: Utc::now().timestamp_millis() + 60_000,
        };
        state.reset_unsettled.lock().await.insert(
            "claude:account-a".into(), original.clone(),
        );
        assert_eq!(
            live_unsettled(&state, "claude:account-a", "account-a").await,
            Some(original.clone()),
        );
        assert_eq!(live_unsettled(&state, "claude:account-a", "account-b").await, None);
        assert_eq!(state.reset_unsettled.lock().await.get("claude:account-a"), Some(&original));
    }

    #[tokio::test]
    async fn claude_unavailable_result_is_unconfirmed() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, owner_body("org-a")),
            (200, claude_status("grant-a", serde_json::json!({}))),
            (200, r#"{"result":"unavailable"}"#.into()),
        ]).await;
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let state = UsageState::new();
        let row = reset_row(CliProvider::Claude);
        let result = use_reset_ticket_inner(&state, &row,
            Ok(claude_source("unavailable-token")), "request-a", None,
            &endpoints(&base, &profile, &usage, None)).await.unwrap();
        assert_eq!(result.kind, ResetTicketOutcomeKind::Unconfirmed);
        assert!(state.reset_unsettled.lock().await.contains_key("claude:account-a"));
        assert_eq!(received.await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn claude_server_already_used_remains_confirmed() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, owner_body("org-a")),
            (200, claude_status("grant-a", serde_json::json!({}))),
            (200, r#"{"result":"already_used"}"#.into()),
        ]).await;
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let state = UsageState::new();
        let outcome = use_reset_ticket_inner(
            &state, &reset_row(CliProvider::Claude),
            Ok(claude_source("already-used-token")), "fresh-id", None,
            &endpoints(&base, &profile, &usage, None),
        ).await.unwrap();
        assert_eq!(outcome.kind, ResetTicketOutcomeKind::AlreadyUsed);
        assert!(!outcome.retry_of_unconfirmed);
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].starts_with("POST "));
    }

    #[tokio::test]
    async fn codex_fresh_details_reuse_and_no_credit() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, serde_json::json!({"credits": [
                {"id": "credit-late", "status": "available",
                    "expires_at": "2099-02-01T00:00:00Z"},
                {"id": "credit-soon", "status": "available",
                    "expires_at": "2099-01-01T00:00:00Z"},
            ]}).to_string()),
            (500, "{}".into()),
            (200, r#"{"code":"no_credit"}"#.into()),
        ]).await;
        let usage = format!("{base}/backend-api/wham/usage");
        let state = UsageState::new();
        let row = reset_row(CliProvider::Codex);
        state.reset_credit_details.lock().await.insert(row.profile_id.clone(), CachedCredits {
            fetched_at_ms: 0, available_count: 1, credits: vec![reset_tickets::CodexCredit {
                id: "stale-credit".into(), title: None, expires_at: None, granted_at: None,
            }],
        });
        let urls = endpoints(&base, &base, &base, Some(&usage));
        let first = use_reset_ticket_inner(&state, &row, Ok(codex_source()),
            "first-id", None, &urls).await.unwrap();
        assert_eq!(first.kind, ResetTicketOutcomeKind::Unconfirmed);
        assert_eq!(
            state.reset_unsettled.lock().await.get("codex:acct-a")
                .unwrap().target_id.as_deref(),
            Some("credit-soon"),
        );
        let cached = state.reset_credit_details.lock().await.get(&row.profile_id).cloned().unwrap();
        assert_eq!(cached.fetched_at_ms, 0);
        assert_eq!(reset_tickets::soonest_credit(&cached.credits).unwrap().id, "credit-soon");
        let second = use_reset_ticket_inner(&state, &row, Ok(codex_source()),
            "second-id", None, &urls).await.unwrap();
        assert_eq!(second.kind, ResetTicketOutcomeKind::NoTicket);
        assert!(second.retry_of_unconfirmed);
        assert!(state.reset_unsettled.lock().await.is_empty());
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("GET /backend-api/wham/rate-limit-reset-credits "));
        assert_eq!(request_body(&requests[1]), serde_json::json!({
            "redeem_request_id": "first-id", "credit_id": "credit-soon"
        }));
        assert_eq!(request_body(&requests[2]), request_body(&requests[1]));
    }

    #[tokio::test]
    async fn codex_uses_remembered_usage_url_and_expires_unsettled() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (200, r#"{"credits":[]}"#.into()),
            (200, r#"{"code":"nothing_to_reset"}"#.into()),
        ]).await;
        let usage = format!("{base}/backend-api/wham/usage");
        let state = UsageState::new();
        let row = reset_row(CliProvider::Codex);
        state.codex_usage_urls.lock().await.insert(row.profile_id.clone(), usage);
        state.reset_unsettled.lock().await.insert("codex:acct-a".into(), UnsettledReset {
            identity: "acct-a".into(),
            request_id: "expired-id".into(), target_id: Some("old-credit".into()),
            started_at_ms: Utc::now().timestamp_millis() - 600_001,
        });
        let result = use_reset_ticket_inner(&state, &row, Ok(codex_source()),
            "fresh-id", None, &ResetEndpoints::production()).await.unwrap();
        assert_eq!(result.kind, ResetTicketOutcomeKind::NothingToReset);
        assert!(!result.retry_of_unconfirmed);
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /backend-api/wham/rate-limit-reset-credits "));
        assert_eq!(request_body(&requests[1]), serde_json::json!({"redeem_request_id":"fresh-id"}));
    }

    #[tokio::test]
    async fn codex_details_failure_falls_back_to_cached_credit() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![
            (500, "{}".into()),
            (200, r#"{"code":"reset"}"#.into()),
        ]).await;
        let usage = format!("{base}/backend-api/wham/usage");
        let state = UsageState::new();
        let row = reset_row(CliProvider::Codex);
        state.reset_credit_details.lock().await.insert(row.profile_id.clone(), CachedCredits {
            fetched_at_ms: 0, available_count: 1, credits: vec![reset_tickets::CodexCredit {
                id: "cached-credit".into(), title: None, expires_at: None, granted_at: None,
            }],
        });
        let outcome = use_reset_ticket_inner(&state, &row, Ok(codex_source()),
            "fresh-id", None, &endpoints(&base, &base, &base, Some(&usage))).await.unwrap();
        assert_eq!(outcome.kind, ResetTicketOutcomeKind::Reset);
        let requests = received.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(request_body(&requests[1]), serde_json::json!({
            "redeem_request_id": "fresh-id", "credit_id": "cached-credit"
        }));
    }

    #[tokio::test]
    async fn reset_invalidation_keeps_stale_windows_for_cooldown() {
        let state = UsageState::new();
        let row = reset_row(CliProvider::Codex);
        let fetched_at_ms = Utc::now().timestamp_millis();
        state.profile_usage_cache.lock().await.insert(row.profile_id.clone(), CachedWindows {
            five_hour: Some(crate::usage::WindowStat { pct: 57.0, resets_at: "later".into() }),
            seven_day: None, seven_day_sonnet: None, seven_day_opus: None,
            model_windows: Vec::new(), reset_tickets: Some(reset_tickets::codex_tickets(2, None)),
            fetched_at_ms,
            invalidated: false,
        });
        stale_reset_usage(&state, &row.profile_id).await;
        assert!(cached_profile_windows(
            &state, &row.profile_id, Utc::now().timestamp_millis(),
        ).await.is_none());
        let cooldown = cooldown_usage(&state, &row, None).await;
        assert_eq!(cooldown.five_hour.unwrap().pct, 57.0);
        assert_eq!(cooldown.reset_tickets.unwrap().available, 2);
        assert_eq!(cooldown.fetched_at, rfc3339(fetched_at_ms));
        assert!(!cooldown.fetched_at.starts_with("1970-"));
    }

    #[tokio::test]
    async fn unsettled_retry_survives_nonsettling_post_outcomes() {
        let state = UsageState::new();
        let row = reset_row(CliProvider::Claude);
        let original = UnsettledReset {
            identity: "account-a".into(),
            request_id: "original-id".into(), target_id: Some("grant-a".into()),
            started_at_ms: Utc::now().timestamp_millis() - 1_000,
        };
        state.reset_unsettled.lock().await.insert("claude:account-a".into(), original.clone());
        for kind in [ResetTicketOutcomeKind::Cooldown, ResetTicketOutcomeKind::RateLimited,
            ResetTicketOutcomeKind::AuthError] {
            settle_reset(&state, "claude:account-a", "account-a", "original-id", Some("grant-a"),
                Some(&original), Utc::now().timestamp_millis(),
                &ResetTicketOutcome::new(kind),
            ).await;
            assert_eq!(state.reset_unsettled.lock().await.get("claude:account-a"), Some(&original));
        }
        settle_reset(&state, "claude:account-a", "account-a", "fresh-id", Some("grant-b"), None,
            Utc::now().timestamp_millis(),
            &ResetTicketOutcome::new(ResetTicketOutcomeKind::RateLimited)).await;
        assert!(!state.reset_unsettled.lock().await.contains_key("claude:account-a"));
    }

    #[tokio::test]
    async fn blocked_rows_send_no_request_and_inflight_is_busy() {
        let (base, received) = reset_tickets::fake_http_sequence(vec![]).await;
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let state = UsageState::new();
        let urls = endpoints(&base, &profile, &usage, None);
        let mut row = reset_row(CliProvider::Claude);
        row.foreign_owner = Some(ForeignTokenOwner {
            account_uuid: "other".into(), email: None, detected_at: "now".into(),
        });
        assert_eq!(use_reset_ticket_inner(&state, &row, Ok(claude_source("blocked-a")),
            "request-a", None, &urls).await.unwrap().kind, ResetTicketOutcomeKind::OwnerMismatch);
        row.foreign_owner = None;
        row.needs_relogin = true;
        assert_eq!(use_reset_ticket_inner(&state, &row, Ok(claude_source("blocked-b")),
            "request-a", None, &urls).await.unwrap().kind, ResetTicketOutcomeKind::AuthError);
        row.needs_relogin = false;
        assert_eq!(use_reset_ticket_inner(&state, &row, Ok(claude_source("blocked-c")),
            "request-a", Some("other@example.test"), &urls).await.unwrap().kind,
            ResetTicketOutcomeKind::OwnerMismatch);
        assert!(received.await.unwrap().is_empty());
        state.reset_in_flight.lock().unwrap().insert(row.profile_id.clone());
        assert_eq!(use_reset_ticket_inner(&state, &row, Ok(claude_source("blocked-d")),
            "request-a", None, &urls).await.unwrap().kind, ResetTicketOutcomeKind::Busy);
        state.reset_in_flight.lock().unwrap().remove(&row.profile_id);
    }

    #[tokio::test]
    async fn second_concurrent_reset_is_busy() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            let n = stream.read(&mut buffer).await.unwrap();
            started_tx.send(()).unwrap();
            resume_rx.await.unwrap();
            stream.write_all(b"HTTP/1.1 503 Failure\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
            String::from_utf8_lossy(&buffer[..n]).into_owned()
        });
        let state = std::sync::Arc::new(UsageState::new());
        let row = reset_row(CliProvider::Claude);
        let first_state = state.clone();
        let first_row = row.clone();
        let first_base = base.clone();
        let first = tokio::spawn(async move {
            let profile = format!("{first_base}/profile");
            let usage = format!("{first_base}/usage");
            use_reset_ticket_inner(&first_state, &first_row,
                Ok(claude_source("concurrent-token")), "first-id", None,
                &endpoints(&first_base, &profile, &usage, None)).await.unwrap()
        });
        started_rx.await.unwrap();
        let profile = format!("{base}/profile");
        let usage = format!("{base}/usage");
        let second = use_reset_ticket_inner(&state, &row,
            Ok(claude_source("concurrent-token")), "second-id", None,
            &endpoints(&base, &profile, &usage, None)).await.unwrap();
        assert_eq!(second.kind, ResetTicketOutcomeKind::Busy);
        resume_tx.send(()).unwrap();
        assert_eq!(first.await.unwrap().kind, ResetTicketOutcomeKind::Unavailable);
        assert!(server.await.unwrap().starts_with("GET /profile "));
    }

    fn profile(id: &str, provider: CliProvider, label: &str, identity: &str) -> CliAccountProfile {
        CliAccountProfile {
            id: id.into(),
            provider,
            label: label.into(),
            email: None,
            identity_key: identity.into(),
            plan: None,
            org_name: None,
            captured_at: "now".into(),
            last_switched_at: None,
            needs_relogin: false,
            refresh_rejected_at: None,
            foreign_token_owner: None,
        }
    }

    fn live(provider: CliProvider, identity: Option<&str>, matched: Option<&str>) -> CliLiveLogin {
        CliLiveLogin {
            provider,
            present: true,
            email: None,
            identity_key: identity.map(str::to_string),
            plan: None,
            org_name: None,
            matched_profile_id: matched.map(str::to_string),
            error: None,
        }
    }

    #[test]
    fn live_identity_check_table() {
        let signed_in = live(CliProvider::Claude, Some("a"), None);
        let anonymous = CliLiveLogin {
            identity_key: None,
            ..live(CliProvider::Claude, None, None)
        };
        let logged_out = CliLiveLogin {
            present: false,
            identity_key: None,
            ..live(CliProvider::Claude, None, None)
        };
        let unreadable = CliLiveLogin {
            error: Some("boom".into()),
            ..live(CliProvider::Claude, Some("a"), None)
        };

        // The account we would refresh is the one in use -- hands off.
        assert!(matches!(
            classify_live_identity(Some(&signed_in), Some("a")),
            LiveIdentityCheck::Active
        ));
        // Somebody else is signed in, so this snapshot is ours to refresh.
        assert!(matches!(
            classify_live_identity(Some(&signed_in), Some("b")),
            LiveIdentityCheck::Inactive
        ));
        // Nobody is signed in for this provider.
        assert!(matches!(
            classify_live_identity(Some(&logged_out), Some("a")),
            LiveIdentityCheck::Inactive
        ));
        // Everything below is a question we cannot answer, and answering it
        // wrong costs the user their CLI session. Refuse rather than guess.
        assert!(matches!(
            classify_live_identity(None, Some("a")),
            LiveIdentityCheck::Unknown
        ));
        assert!(matches!(
            classify_live_identity(Some(&unreadable), Some("a")),
            LiveIdentityCheck::Unknown
        ));
        assert!(matches!(
            classify_live_identity(Some(&anonymous), Some("a")),
            LiveIdentityCheck::Unknown
        ));
        assert!(matches!(
            classify_live_identity(Some(&signed_in), None),
            LiveIdentityCheck::Unknown
        ));
    }

    #[test]
    fn codex_unauthorized_retry_only_once_and_never_for_active() {
        // status, is_active, already_refreshed, has_refresh_token, disabled
        let allowed = should_retry_codex_after_unauthorized(Some(401), false, false, true, false);
        assert!(allowed);
        assert!(should_retry_codex_after_unauthorized(
            Some(403),
            false,
            false,
            true,
            false
        ));

        // Never for the account the CLI holds: that is the whole point of D5.
        assert!(!should_retry_codex_after_unauthorized(
            Some(401),
            true,
            false,
            true,
            false
        ));
        // Never twice in one poll.
        assert!(!should_retry_codex_after_unauthorized(
            Some(401),
            false,
            true,
            true,
            false
        ));
        // Nothing to refresh with.
        assert!(!should_retry_codex_after_unauthorized(
            Some(401),
            false,
            false,
            false,
            false
        ));
        // The endpoint already told us it does not accept our refresh grant.
        assert!(!should_retry_codex_after_unauthorized(
            Some(401),
            false,
            false,
            true,
            true
        ));
        // Other statuses are not an authentication problem.
        for status in [None, Some(400), Some(429), Some(500)] {
            assert!(!should_retry_codex_after_unauthorized(
                status, false, false, true, false
            ));
        }
    }

    // grok's single profile is always the live one, so a retry gated on
    // is_active -- the rule claude and codex use -- would never fire and the
    // windows would stay empty until the next manual `grok login`.
    #[test]
    fn grok_retries_where_claude_and_codex_wait_for_the_cli() {
        assert!(should_retry_grok_after_unauthorized(Some(401), false, false));
        assert!(should_retry_grok_after_unauthorized(Some(403), false, false));
        assert!(!should_retry_grok_after_unauthorized(Some(401), true, false));
        for status in [None, Some(400), Some(429), Some(500)] {
            assert!(!should_retry_grok_after_unauthorized(status, false, false));
        }

        assert!(!should_retry_claude_after_unauthorized(
            Some(401),
            true,
            false
        ));
        assert!(!should_retry_codex_after_unauthorized(
            Some(401),
            true,
            false,
            true,
            false
        ));
    }

    // An active row reads its tokens from auth.json, so a rotated token written
    // to the snapshot instead would never be read back -- by mycmux or the CLI.
    #[test]
    fn grok_rotated_tokens_follow_the_file_the_row_reads() {
        // Active, and live-only rows that have no snapshot to read: both take
        // their tokens from auth.json, so both must write back there.
        assert_eq!(grok_token_destination(true, true), GrokTokenDestination::LiveAuth);
        assert_eq!(grok_token_destination(true, false), GrokTokenDestination::LiveAuth);
        assert_eq!(grok_token_destination(false, false), GrokTokenDestination::LiveAuth);
        assert_eq!(grok_token_destination(false, true), GrokTokenDestination::Snapshot);
    }

    #[test]
    fn grok_415_stops_future_polls_and_logs_only_once() {
        let disabled = AtomicBool::new(false);
        let error = refresh::classify_refresh_error(Some(415), None);
        assert!(should_log_refresh_failure(CliProvider::Grok, &error, &disabled));
        assert!(disabled.load(Ordering::Relaxed));
        for _ in 0..3 {
            assert!(!should_log_refresh_failure(CliProvider::Grok, &error, &disabled));
            for status in [Some(401), Some(403)] {
                assert!(!should_retry_grok_after_unauthorized(
                    status, false, disabled.load(Ordering::Relaxed),
                ));
            }
        }
    }

    #[test]
    fn other_providers_and_retryable_failures_do_not_stop_grok() {
        let disabled = AtomicBool::new(false);
        let unsupported = refresh::classify_refresh_error(Some(415), None);
        for provider in [CliProvider::Claude, CliProvider::Codex] {
            assert!(should_log_refresh_failure(provider, &unsupported, &disabled));
            assert!(!disabled.load(Ordering::Relaxed));
        }
        for status in [None, Some(401), Some(429), Some(500)] {
            let error = refresh::classify_refresh_error(status, None);
            assert!(should_log_refresh_failure(CliProvider::Grok, &error, &disabled));
            assert!(!disabled.load(Ordering::Relaxed));
        }
    }

    #[test]
    fn grok_snapshot_persistence_requires_rotated_refresh_token() {
        assert!(!should_persist_grok_snapshot(None));
        assert!(should_persist_grok_snapshot(Some("rotated-refresh-token")));
    }

    #[test]
    fn planned_rows_include_unregistered_live_login() {
        let rows = planned_rows(&[], &[live(CliProvider::Claude, Some("a"), None)]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].profile_id, "live:claude");
        let rows = planned_rows(
            &[profile("claude-a", CliProvider::Claude, "A", "a")],
            &[live(CliProvider::Claude, Some("a"), Some("claude-a"))],
        );
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn planned_rows_mark_active_by_identity() {
        let profiles = [
            profile("a", CliProvider::Claude, "A", "a"),
            profile("b", CliProvider::Claude, "B", "b"),
        ];
        let rows = planned_rows(
            &profiles,
            &[live(CliProvider::Claude, Some("b"), Some("b"))],
        );
        assert!(
            !rows
                .iter()
                .find(|row| row.profile_id == "a")
                .unwrap()
                .is_active
        );
        assert!(
            rows.iter()
                .find(|row| row.profile_id == "b")
                .unwrap()
                .is_active
        );
        assert!(planned_rows(&profiles, &[])
            .iter()
            .all(|row| !row.is_active));
    }

    #[test]
    fn planned_rows_are_stable_order() {
        let first = planned_rows(
            &[
                profile("c", CliProvider::Codex, "B", "c"),
                profile("a", CliProvider::Claude, "Z", "a"),
                profile("b", CliProvider::Claude, "A", "b"),
            ],
            &[],
        )
        .into_iter()
        .map(|row| row.profile_id)
        .collect::<Vec<_>>();
        let second = planned_rows(
            &[
                profile("b", CliProvider::Claude, "A", "b"),
                profile("a", CliProvider::Claude, "Z", "a"),
                profile("c", CliProvider::Codex, "B", "c"),
            ],
            &[],
        )
        .into_iter()
        .map(|row| row.profile_id)
        .collect::<Vec<_>>();
        assert_eq!(first, second);
        assert_eq!(first, vec!["b", "a", "c"]);
    }

    #[test]
    fn cooldown_keys_separate_profiles_from_providers() {
        // A profile called "claude" must not be able to pause the whole
        // provider by colliding with its key.
        assert_ne!(
            profile_cooldown_key("claude"),
            provider_cooldown_key(CliProvider::Claude)
        );
        assert_ne!(
            provider_cooldown_key(CliProvider::Claude),
            provider_cooldown_key(CliProvider::Codex)
        );
        assert_eq!(profile_cooldown_key("abc"), "profile:abc");
    }

    #[tokio::test]
    async fn provider_pause_starts_on_the_second_rate_limited_account() {
        let state = UsageState::new();
        let key = provider_cooldown_key(CliProvider::Claude);
        let now = 1_000;

        // One account hitting a 429 says nothing about the address.
        let mut seen = 0usize;
        seen += 1;
        assert!(seen < PROVIDER_PAUSE_THRESHOLD);
        assert!(active_cooldown(&state, &key, now).await.is_none());

        // The second one does, and the provider goes quiet for the base window.
        seen += 1;
        assert!(seen >= PROVIDER_PAUSE_THRESHOLD);
        apply_429_cooldown(&state, &key, now).await;
        let paused = active_cooldown(&state, &key, now).await.expect("paused");
        assert_eq!(paused.until_ms, now + COOLDOWN_BASE_MS);
        // Other providers are unaffected.
        assert!(
            active_cooldown(&state, &provider_cooldown_key(CliProvider::Codex), now)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn cooldown_rows_keep_last_successful_numbers() {
        use crate::usage::WindowStat;
        let state = UsageState::new();
        let row = PlannedRow {
            profile_id: "p".into(),
            provider: CliProvider::Claude,
            label: "L".into(),
            email: None,
            plan: None,
            identity_key: None,
            registered: true,
            is_active: false,
            needs_relogin: false,
            foreign_owner: None,
        };

        // Nothing fetched yet: the cooldown row is honestly blank.
        let blank = cooldown_usage(&state, &row, Some("soon".into())).await;
        assert_eq!(blank.state, UsageRowState::Cooldown);
        assert!(blank.five_hour.is_none());

        state.profile_usage_cache.lock().await.insert(
            "p".into(),
            CachedWindows {
                five_hour: Some(WindowStat {
                    pct: 12.0,
                    resets_at: "r".into(),
                }),
                seven_day: None,
                seven_day_sonnet: None,
                seven_day_opus: None,
                model_windows: Vec::new(),
                reset_tickets: Some(reset_tickets::codex_tickets(1, None)),
                fetched_at_ms: 1,
                invalidated: false,
            },
        );

        // The fresh path refuses an expired entry...
        let long_after = 1 + USAGE_CACHE_TTL_MS * 10;
        assert!(cached_profile_windows(&state, "p", long_after)
            .await
            .is_none());
        // ...but the cooldown row still carries it, dated by its own fetch time.
        let usage = cooldown_usage(&state, &row, Some("soon".into())).await;
        assert_eq!(usage.state, UsageRowState::Cooldown);
        assert_eq!(usage.error_code.as_deref(), Some(ERROR_RATE_LIMITED));
        assert_eq!(usage.retry_at.as_deref(), Some("soon"));
        assert_eq!(usage.five_hour.as_ref().map(|stat| stat.pct), Some(12.0));
        assert_eq!(usage.reset_tickets.as_ref().map(|tickets| tickets.available), Some(1));
        assert_eq!(usage.fetched_at, rfc3339(1));
    }

    #[tokio::test]
    async fn codex_details_use_round_budget_and_cache() {
        let (base, request) = reset_tickets::fake_http_once(r#"{"credits":[{"id":"credit-1","status":"available","expires_at":"2026-10-22T00:00:00Z","title":"Full"}]}"#).await;
        let state = UsageState::new();
        let row = PlannedRow { profile_id: "p".into(), provider: CliProvider::Codex, label: "P".into(),
            email: None, plan: None, identity_key: None, registered: true, is_active: false,
            needs_relogin: false, foreign_owner: None };
        let usage = oauth_codex::CodexUsage { five_hour: None, seven_day: None, reset_count: Some(1),
            usage_url: format!("{base}/backend-api/wham/usage") };
        let mut count = 0;
        let tickets = codex_reset_tickets(&state, &row, &usage, "synthetic-token", None, &mut count).await.unwrap();
        assert_eq!(count, 1);
        assert_eq!(tickets.expires_at.as_deref(), Some("2026-10-22T00:00:00Z"));
        assert!(request.await.unwrap().starts_with("GET /backend-api/wham/rate-limit-reset-credits HTTP/1.1"));
        let again = codex_reset_tickets(&state, &row, &usage, "synthetic-token", None, &mut count).await.unwrap();
        assert_eq!(again.available, 1);
        assert_eq!(count, 1);
        let empty = oauth_codex::CodexUsage { reset_count: Some(0), ..usage };
        assert_eq!(codex_reset_tickets(&state, &row, &empty, "synthetic-token", None, &mut count).await.unwrap().available, 0);
        assert!(state.reset_credit_details.lock().await.get("p").is_none());
    }

    #[test]
    fn claude_unauthorized_retry_only_once_and_never_for_active() {
        // status, is_active, already_refreshed
        assert!(should_retry_claude_after_unauthorized(
            Some(401),
            false,
            false
        ));
        assert!(should_retry_claude_after_unauthorized(
            Some(403),
            false,
            false
        ));
        // The CLI holds this account; it rotates its own tokens.
        assert!(!should_retry_claude_after_unauthorized(
            Some(401),
            true,
            false
        ));
        // Never twice in one poll.
        assert!(!should_retry_claude_after_unauthorized(
            Some(401),
            false,
            true
        ));
        // Other statuses are not an authentication problem.
        for status in [None, Some(400), Some(429), Some(500)] {
            assert!(!should_retry_claude_after_unauthorized(
                status, false, false
            ));
        }
    }

    #[test]
    fn processing_order_puts_deferred_rows_first_without_reordering_output() {
        let row = |id: &str| PlannedRow {
            profile_id: id.into(),
            provider: CliProvider::Claude,
            label: id.into(),
            email: None,
            plan: None,
            identity_key: None,
            registered: true,
            is_active: false,
            needs_relogin: false,
            foreign_owner: None,
        };
        let rows = vec![row("a"), row("b"), row("c"), row("d")];

        // No history: planned order.
        assert_eq!(processing_order(&rows, &[]), vec![0, 1, 2, 3]);
        // Deferred rows jump the queue in their deferred order; the rest keep
        // their planned positions. Ids that no longer exist are ignored.
        let priority = vec!["c".to_string(), "b".to_string(), "gone".to_string()];
        assert_eq!(processing_order(&rows, &priority), vec![2, 1, 0, 3]);

        // The logged-in account goes ahead of everything, deferred rows
        // included: it is the row the title bar and the auto-switch read.
        let mut with_active = rows.clone();
        with_active[3].is_active = true;
        assert_eq!(processing_order(&with_active, &[]), vec![3, 0, 1, 2]);
        assert_eq!(processing_order(&with_active, &priority), vec![3, 2, 1, 0]);
        let active_and_deferred = vec!["d".to_string(), "b".to_string()];
        assert_eq!(
            processing_order(&with_active, &active_and_deferred),
            vec![3, 1, 0, 2]
        );
    }

    #[test]
    fn round_budget_is_counted_per_provider() {
        let mut budget = RoundBudget::default();
        // Every Codex and Grok request of a round spent...
        for _ in 0..MAX_FETCH_PER_ROUND {
            *budget.counter(CliProvider::Codex) += 1;
            *budget.counter(CliProvider::Grok) += 1;
        }
        assert!(budget.exhausted(CliProvider::Codex));
        assert!(budget.exhausted(CliProvider::Grok));
        // ...leaves Claude's untouched: they never reach Anthropic's limit.
        assert!(!budget.exhausted(CliProvider::Claude));
        for _ in 0..MAX_FETCH_PER_ROUND - 1 {
            *budget.counter(CliProvider::Claude) += 1;
        }
        assert!(!budget.exhausted(CliProvider::Claude));
        *budget.counter(CliProvider::Claude) += 1;
        assert!(budget.exhausted(CliProvider::Claude));
        assert_eq!(budget.summary(), "claude:12 codex:12 grok:12");
    }

    #[tokio::test]
    async fn deferred_rows_keep_recent_numbers() {
        use crate::usage::WindowStat;
        let state = UsageState::new();
        let row = PlannedRow {
            profile_id: "p".into(),
            provider: CliProvider::Claude,
            label: "L".into(),
            email: None,
            plan: None,
            identity_key: None,
            registered: true,
            is_active: false,
            needs_relogin: false,
            foreign_owner: None,
        };
        let fetched_at_ms = 1_000_000;
        let cached = |invalidated: bool| CachedWindows {
            five_hour: Some(WindowStat {
                pct: 40.0,
                resets_at: "r".into(),
            }),
            seven_day: Some(WindowStat {
                pct: 9.0,
                resets_at: "r".into(),
            }),
            seven_day_sonnet: None,
            seven_day_opus: None,
            model_windows: Vec::new(),
            reset_tickets: Some(reset_tickets::codex_tickets(1, None)),
            fetched_at_ms,
            invalidated,
        };

        // Never fetched (the first round after a start): honestly blank.
        let blank = deferred_usage(&state, &row, fetched_at_ms).await;
        assert_eq!(blank.state, UsageRowState::Error);
        assert_eq!(blank.error_code.as_deref(), Some(ERROR_DEFERRED));
        assert!(blank.five_hour.is_none() && blank.seven_day.is_none());

        state
            .profile_usage_cache
            .lock()
            .await
            .insert("p".into(), cached(false));
        // One poll interval later the fresh path has let go of the entry...
        let next_round = fetched_at_ms + 180_000;
        assert!(cached_profile_windows(&state, "p", next_round).await.is_none());
        // ...but a deferred row still shows it, as a cache hit would: no error,
        // dated by its own fetch time rather than by this round.
        let shown = deferred_usage(&state, &row, next_round).await;
        assert_eq!(shown.state, UsageRowState::Ok);
        assert_eq!(shown.error_code, None);
        assert_eq!(shown.five_hour.as_ref().map(|stat| stat.pct), Some(40.0));
        assert_eq!(shown.seven_day.as_ref().map(|stat| stat.pct), Some(9.0));
        assert_eq!(shown.reset_tickets.as_ref().map(|tickets| tickets.available), Some(1));
        assert_eq!(shown.fetched_at, rfc3339(fetched_at_ms));

        // Too old to pass for current (a wake from sleep): blank again.
        let after_sleep = fetched_at_ms + DEFERRED_STALE_MAX_MS;
        let stale = deferred_usage(&state, &row, after_sleep).await;
        assert_eq!(stale.error_code.as_deref(), Some(ERROR_DEFERRED));
        assert!(stale.five_hour.is_none());

        // A spent reset ticket makes the old numbers wrong, not just old.
        state
            .profile_usage_cache
            .lock()
            .await
            .insert("p".into(), cached(true));
        let reset = deferred_usage(&state, &row, next_round).await;
        assert_eq!(reset.error_code.as_deref(), Some(ERROR_DEFERRED));
        assert!(reset.five_hour.is_none());
    }

    #[tokio::test]
    async fn success_clears_profile_and_provider_cooldowns() {
        let state = UsageState::new();
        let row = PlannedRow {
            profile_id: "p".into(),
            provider: CliProvider::Claude,
            label: "L".into(),
            email: None,
            plan: None,
            identity_key: None,
            registered: true,
            is_active: false,
            needs_relogin: false,
            foreign_owner: None,
        };
        let profile_key = profile_cooldown_key("p");
        let provider_key = provider_cooldown_key(CliProvider::Claude);
        apply_429_cooldown(&state, &profile_key, 1).await;
        apply_429_cooldown(&state, &provider_key, 1).await;
        apply_429_cooldown(&state, &provider_key, 1).await; // backoff has grown

        successful_fetch(
            &state,
            &row,
            None,
            None,
            None,
            None,
            Vec::new(),
            None,
            &profile_key,
        )
        .await;

        // Both entries are gone, so the next 429 starts from the base backoff
        // instead of resuming a stale doubled one.
        let cooldowns = state.cooldowns.lock().await;
        assert!(!cooldowns.contains_key(&profile_key));
        assert!(!cooldowns.contains_key(&provider_key));
    }

    #[tokio::test]
    async fn cooldown_backoff_doubles_and_caps() {
        let state = UsageState::new();
        let key = "profile:claude-a";
        let mut values = Vec::new();
        for _ in 0..5 {
            apply_429_cooldown(&state, key, 1).await;
            values.push(state.cooldowns.lock().await[key].backoff_ms);
        }
        assert_eq!(
            values,
            vec![300_000, 600_000, 1_200_000, 1_800_000, 1_800_000]
        );
    }
    #[test]
    fn claude_owner_gate_table() {
        let owner = TokenOwner { account_uuid: "X".into(), email: Some("x@example.test".into()), organization_uuid: None };
        for active in [true, false] {
            for registered in [true, false] {
                let check = OwnerCheck::Owner(owner.clone());
                for identity in [Some("X"), None] {
                    assert_eq!(claude_owner_gate(identity, active, registered, &check), OwnerGate::Proceed);
                }
                let expected = if active || !registered { OwnerGate::LiveForeign(owner.clone()) }
                    else { OwnerGate::SnapshotForeign(owner.clone()) };
                assert_eq!(claude_owner_gate(Some("P"), active, registered, &check), expected);
                for (check, expected) in [
                    (OwnerCheck::Rejected { status: 401 }, Some(401)),
                    (OwnerCheck::Rejected { status: 403 }, Some(403)),
                    (OwnerCheck::RateLimited { retry_after_secs: Some(600) }, Some(429)),
                    (OwnerCheck::Unavailable, None),
                ] {
                    assert_eq!(claude_owner_gate(Some("P"), active, registered, &check), OwnerGate::AsFailure(expected));
                }
            }
        }
    }

    #[test]
    fn shares_live_refresh_token_table() {
        let live = include_str!("../cli_accounts/fixtures/claude_credentials_sample.json");
        assert!(shares_live_refresh_token("synthetic-refresh", Some(live)));
        assert!(!shares_live_refresh_token("another-refresh", Some(live)));
        assert!(!shares_live_refresh_token("synthetic-refresh", None));
        assert!(!shares_live_refresh_token("synthetic-refresh", Some("broken")));
        assert!(!shares_live_refresh_token("", Some("{}")));
    }

    #[test]
    fn foreign_token_rows_never_carry_usage_windows() {
        let mut p = profile("claude-p", CliProvider::Claude, "P", "P");
        p.foreign_token_owner = Some(ForeignTokenOwner {
            account_uuid: "X".into(), email: Some("x@example.test".into()), detected_at: "now".into(),
        });
        let rows = planned_rows(&[p], &[live(CliProvider::Claude, Some("P"), Some("claude-p"))]);
        let row = &rows[0];
        assert!(row.foreign_owner.is_some());
        for snapshot in [true, false] {
            let usage = foreign_token_usage(row, Some("x@example.test".into()), snapshot);
            assert_eq!(usage.state, if snapshot { UsageRowState::NeedsRelogin } else { UsageRowState::Error });
            assert_eq!(usage.error_code.as_deref(), Some(if snapshot { ERROR_FOREIGN_TOKEN } else { ERROR_LIVE_TOKEN_FOREIGN }));
            assert_eq!(usage.needs_relogin, snapshot);
            assert!(usage.five_hour.is_none() && usage.seven_day.is_none());
            assert!(usage.seven_day_sonnet.is_none() && usage.seven_day_opus.is_none() && usage.model_windows.is_empty());
            assert_eq!(serde_json::to_value(&usage).unwrap()["token_owner_email"], "x@example.test");
        }
        assert!(planned_rows(&[], &[live(CliProvider::Claude, Some("P"), None)])[0].foreign_owner.is_none());
    }

}
