use chrono::Utc;

use crate::cli_accounts::{
    claude::{self, ClaudePaths},
    codex::{self, CodexPaths},
    CliAccountProfile, CliLiveLogin, CliProvider, SnapshotUpdate,
};
use crate::usage::{
    credentials, oauth_claude, oauth_codex, refresh, AccountUsageReport, CachedWindows, Cooldown,
    ProfileUsage, UsageRowState, UsageState, USAGE_CACHE_TTL_MS,
};
use tauri::Manager;

const COOLDOWN_BASE_MS: i64 = 300_000;
const COOLDOWN_MAX_MS: i64 = 1_800_000;
/// Ceiling on outbound requests per poll. Counted in requests, not rows: a row
/// that has to refresh spends two (refresh + usage), and one that refreshes
/// after a 401 spends three. Anthropic rate-limits by IP, so the budget belongs
/// to the whole round rather than to each account. Rows that run out of budget
/// go first on the next round (see `deferred_priority`), so a long account
/// list rotates through instead of starving its tail.
const MAX_FETCH_PER_ROUND: usize = 12;
const ERROR_RATE_LIMITED: &str = "usage.error.rate_limited";
const ERROR_NEEDS_RELOGIN: &str = "usage.error.needs_relogin";
const ERROR_TOKEN_EXPIRED_ACTIVE: &str = "usage.error.token_expired_active";
const ERROR_CODEX_UNSUPPORTED: &str = "usage.error.codex_unsupported";
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
            }
            .into(),
            provider: login.provider,
            label: login.email.clone().unwrap_or_else(|| {
                match login.provider {
                    CliProvider::Claude => "Claude live login",
                    CliProvider::Codex => "Codex live login",
                }
                .into()
            }),
            email: login.email.clone(),
            plan: login.plan.clone(),
            identity_key: login.identity_key.clone(),
            registered: false,
            is_active: true,
            needs_relogin: false,
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
        error_code: error_code.map(str::to_string),
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
        .filter(|cached| now_ms.saturating_sub(cached.fetched_at_ms) < USAGE_CACHE_TTL_MS)
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
    }
    .map(str::to_string)
    .ok_or_else(|| ERROR_SNAPSHOT_UNAVAILABLE.to_string())
}

#[tauri::command(async)]
pub async fn get_account_usage(
    app: tauri::AppHandle,
    state: tauri::State<'_, UsageState>,
) -> Result<AccountUsageReport, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let accounts = crate::cli_accounts::list_resolved(&base)?;
    let rows = planned_rows(&accounts.profiles, &accounts.live);
    let priority = std::mem::take(&mut *state.deferred_priority.lock().await);
    let mut output = Vec::with_capacity(rows.len());
    let mut deferred_ids = Vec::new();
    let mut fetch_count = 0usize;
    let mut provider_rate_limited: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for index in processing_order(&rows, &priority) {
        let row = rows[index].clone();
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
        if fetch_count >= MAX_FETCH_PER_ROUND {
            deferred_ids.push(row.profile_id.clone());
            output.push((
                index,
                profile_usage(&row, UsageRowState::Error, Some(ERROR_DEFERRED), None),
            ));
            continue;
        }
        let source = if row.is_active {
            match row.provider {
                CliProvider::Claude => ClaudePaths::resolve()
                    .ok()
                    .and_then(|paths| std::fs::read_to_string(paths.credentials).ok()),
                CliProvider::Codex => CodexPaths::resolve()
                    .ok()
                    .and_then(|paths| std::fs::read_to_string(paths.auth).ok()),
            }
            .ok_or_else(|| ERROR_SNAPSHOT_UNAVAILABLE.to_string())
        } else if row.registered {
            snapshot_text(&base, &row.profile_id, row.provider)
        } else {
            match row.provider {
                CliProvider::Claude => ClaudePaths::resolve()
                    .ok()
                    .and_then(|paths| std::fs::read_to_string(paths.credentials).ok()),
                CliProvider::Codex => CodexPaths::resolve()
                    .ok()
                    .and_then(|paths| std::fs::read_to_string(paths.auth).ok()),
            }
            .ok_or_else(|| ERROR_SNAPSHOT_UNAVAILABLE.to_string())
        };
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
        let result = match row.provider {
            CliProvider::Claude => {
                fetch_claude_profile(
                    &app,
                    &state,
                    &base,
                    &row,
                    &source,
                    &cooldown_key,
                    &mut fetch_count,
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
                    &mut fetch_count,
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
    *state.deferred_priority.lock().await = deferred_ids;
    output.sort_by_key(|(index, _)| *index);
    Ok(AccountUsageReport {
        accounts: output.into_iter().map(|(_, usage)| usage).collect(),
        generated_at: Utc::now().to_rfc3339(),
    })
}

/// The order rows are *processed* in, distinct from the order they are
/// reported in: rows deferred last round come first so the budget reaches
/// them, everything else keeps its planned position.
fn processing_order(rows: &[PlannedRow], priority: &[String]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by_key(|&index| {
        match priority.iter().position(|id| id == &rows[index].profile_id) {
            Some(rank) => (0usize, rank, index),
            None => (1usize, 0usize, index),
        }
    });
    order
}

struct FetchResult {
    usage: ProfileUsage,
}

/// Space out requests and charge one unit of the round's budget. Called before
/// every outbound request including refreshes, so a refreshing row advances the
/// counter more than once. Rows served from cache or held in cooldown never
/// reach here and cost nothing.
async fn stagger_before_fetch(fetch_count: &mut usize) {
    if *fetch_count > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    *fetch_count += 1;
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
        stagger_before_fetch(fetch_count).await;
        let (status, detail) =
            match oauth_claude::fetch_with_token_status(&state.http, &access_token).await {
                Ok(usage) => {
                    return successful_fetch(
                        state,
                        row,
                        usage.five_hour,
                        usage.seven_day,
                        usage.seven_day_sonnet,
                        usage.seven_day_opus,
                        usage.model_windows,
                        cooldown_key,
                    )
                    .await
                }
                Err(error) => error,
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

/// Refresh an inactive Claude snapshot and persist the new tokens before using
/// them. Returns the fresh access token, or the FetchResult the caller should
/// return as-is.
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
    stagger_before_fetch(fetch_count).await;
    let refreshed = match refresh::refresh_claude(&state.http, &tokens.refresh_token).await {
        Ok(value) => value,
        Err(error) => return Err(refresh_failure(app, state, row, cooldown_key, error).await),
    };
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
                return successful_fetch(
                    state,
                    row,
                    usage.five_hour,
                    usage.seven_day,
                    None,
                    None,
                    Vec::new(),
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
    cooldown_key: &str,
) -> FetchResult {
    let fetched_at_ms = Utc::now().timestamp_millis();
    let windows = CachedWindows {
        five_hour,
        seven_day,
        seven_day_sonnet,
        seven_day_opus,
        model_windows,
        fetched_at_ms,
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
    let Ok(base) = app.path().app_data_dir() else {
        return false;
    };
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
    let Ok(base) = app.path().app_data_dir() else {
        crate::usage::log_oauth_failure(
            app,
            "get_account_usage_refresh_record",
            &format!("profile={} app_data_dir_unavailable", row.profile_id),
        );
        return;
    };
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
    crate::usage::log_oauth_failure(
        app,
        "get_account_usage_refresh",
        &format!(
            "provider={:?} profile={} active={} {error:?}",
            row.provider, row.profile_id, row.is_active
        ),
    );
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
                Some(ERROR_CODEX_UNSUPPORTED),
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
                fetched_at_ms: 1,
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
        assert_eq!(usage.fetched_at, rfc3339(1));
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
        };
        let rows = vec![row("a"), row("b"), row("c"), row("d")];

        // No history: planned order.
        assert_eq!(processing_order(&rows, &[]), vec![0, 1, 2, 3]);
        // Deferred rows jump the queue in their deferred order; the rest keep
        // their planned positions. Ids that no longer exist are ignored.
        let priority = vec!["c".to_string(), "b".to_string(), "gone".to_string()];
        assert_eq!(processing_order(&rows, &priority), vec![2, 1, 0, 3]);
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
}
