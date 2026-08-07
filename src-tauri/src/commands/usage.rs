use chrono::Utc;
use serde::Serialize;

use crate::cli_accounts::{
    claude::{self, ClaudePaths},
    codex::{self, CodexPaths},
};
use crate::usage::token_store::{self, StoredTokens, UsageAccountMeta};
use crate::usage::{
    oauth_claude, oauth_codex, oauth_login, AccountUsage, CachedUsage, Cooldown, PendingLogin,
    UsageOauthState, UsageSummary, PENDING_LOGIN_TTL_SECS, USAGE_CACHE_TTL_MS,
};

const COOLDOWN_BASE_MS: i64 = 300_000;
const COOLDOWN_MAX_MS: i64 = 1_800_000;

#[derive(Debug, Default, PartialEq, Eq)]
struct UsageIdentityStamp {
    claude_identity_key: Option<String>,
    claude_email: Option<String>,
    codex_identity_key: Option<String>,
    codex_email: Option<String>,
}

fn read_usage_identity_stamp(
    claude_paths: Option<&ClaudePaths>,
    codex_paths: Option<&CodexPaths>,
) -> UsageIdentityStamp {
    let claude_live = claude_paths
        .map(claude::read_live_identity)
        .filter(|login| login.error.is_none());
    let codex_live = codex_paths
        .map(codex::read_live_identity)
        .filter(|login| login.error.is_none());

    UsageIdentityStamp {
        claude_identity_key: claude_live
            .as_ref()
            .and_then(|login| login.identity_key.clone()),
        claude_email: claude_live.and_then(|login| login.email),
        codex_identity_key: codex_live
            .as_ref()
            .and_then(|login| login.identity_key.clone()),
        codex_email: codex_live.and_then(|login| login.email),
    }
}

fn stable_usage_identity_stamp(
    before: UsageIdentityStamp,
    after: UsageIdentityStamp,
) -> UsageIdentityStamp {
    if before == after {
        before
    } else {
        UsageIdentityStamp::default()
    }
}

fn stamp_usage_summary(mut summary: UsageSummary, identity: UsageIdentityStamp) -> UsageSummary {
    summary.claude_identity_key = identity.claude_identity_key;
    summary.claude_email = identity.claude_email;
    summary.codex_identity_key = identity.codex_identity_key;
    summary.codex_email = identity.codex_email;
    summary
}

#[tauri::command]
pub async fn get_usage_summary() -> Result<UsageSummary, String> {
    let claude_paths = ClaudePaths::resolve().ok();
    let codex_paths = CodexPaths::resolve().ok();
    let identity_before = read_usage_identity_stamp(claude_paths.as_ref(), codex_paths.as_ref());
    let (claude_result, codex_result) = tokio::join!(oauth_claude::fetch(), oauth_codex::fetch());
    let identity_after = read_usage_identity_stamp(claude_paths.as_ref(), codex_paths.as_ref());
    let identity = stable_usage_identity_stamp(identity_before, identity_after);

    let (claude_5h, claude_7d, claude_7d_sonnet, claude_7d_opus, claude_available, claude_error) =
        match claude_result {
            Ok(usage) => {
                let available = usage.has_usage();
                (
                    usage.five_hour,
                    usage.seven_day,
                    usage.seven_day_sonnet,
                    usage.seven_day_opus,
                    available,
                    None,
                )
            }
            Err(error) => (None, None, None, None, false, Some(error)),
        };

    let (codex_5h, codex_7d, codex_available, codex_error) = match codex_result {
        Ok(usage) => {
            let available = usage.has_usage();
            (usage.five_hour, usage.seven_day, available, None)
        }
        Err(error) => (None, None, false, Some(error)),
    };

    Ok(stamp_usage_summary(
        UsageSummary {
            claude_5h,
            claude_7d,
            claude_7d_sonnet,
            claude_7d_opus,
            codex_5h,
            codex_7d,
            claude_available,
            codex_available,
            claude_error,
            codex_error,
            claude_identity_key: None,
            claude_email: None,
            codex_identity_key: None,
            codex_email: None,
            generated_at: chrono::Utc::now().to_rfc3339(),
        },
        identity,
    ))
}

#[derive(Serialize)]
pub struct StartOauthLogin {
    pub login_id: String,
    pub authorize_url: String,
}

#[tauri::command]
pub async fn start_oauth_login(
    state: tauri::State<'_, UsageOauthState>,
) -> Result<StartOauthLogin, String> {
    let pkce = oauth_login::generate_pkce();
    let login_id = uuid::Uuid::new_v4().to_string();
    let redirect_uri = oauth_login::REDIRECT_URI_CANDIDATES[0].to_string();
    let authorize_url = oauth_login::build_authorize_url(&pkce, &redirect_uri)?;

    let mut pending = state.pending_logins.lock().await;
    pending.retain(|_, login| {
        login.created_at.elapsed() <= std::time::Duration::from_secs(PENDING_LOGIN_TTL_SECS)
    });
    pending.insert(
        login_id.clone(),
        PendingLogin {
            verifier: pkce.verifier,
            state: pkce.state,
            redirect_uri,
            created_at: std::time::Instant::now(),
        },
    );

    Ok(StartOauthLogin {
        login_id,
        authorize_url,
    })
}

#[tauri::command]
pub async fn complete_oauth_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, UsageOauthState>,
    login_id: String,
    pasted_code: String,
) -> Result<UsageAccountMeta, String> {
    let result = complete_oauth_login_inner(&app, &state, login_id, pasted_code).await;
    if let Err(error) = &result {
        // Persist the failure — release builds have no stderr and the dialog
        // error text is otherwise the only (ephemeral) evidence.
        crate::usage::log_oauth_failure(&app, "complete_oauth_login", error);
    }
    result
}

async fn complete_oauth_login_inner(
    app: &tauri::AppHandle,
    state: &UsageOauthState,
    login_id: String,
    pasted_code: String,
) -> Result<UsageAccountMeta, String> {
    let pending = {
        let mut pending_logins = state.pending_logins.lock().await;
        pending_logins.retain(|_, login| {
            login.created_at.elapsed() <= std::time::Duration::from_secs(PENDING_LOGIN_TTL_SECS)
        });
        pending_logins
            .get(&login_id)
            .cloned()
            .ok_or_else(|| "Unknown or expired login attempt; restart login".to_string())?
    };

    let (code, pasted_state) = oauth_login::parse_pasted_code(&pasted_code)?;
    if pasted_state != pending.state {
        return Err("OAuth state mismatch; check the pasted code and retry".to_string());
    }

    let response = oauth_login::exchange_code(
        &state.http,
        &code,
        &pasted_state,
        &pending.verifier,
        &pending.redirect_uri,
    )
    .await?;

    let account_uuid = response
        .account
        .as_ref()
        .and_then(|account| nonempty(account.uuid.as_deref()));
    let email = response
        .account
        .as_ref()
        .and_then(|account| nonempty(account.email_address.as_deref()));
    let proposed_account_id = account_uuid.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let existing_accounts = token_store::load_accounts(app)?;
    let existing = existing_accounts
        .iter()
        .find(|account| account.account_id == proposed_account_id)
        .or_else(|| {
            existing_accounts.iter().find(|account| {
                email
                    .as_deref()
                    .zip(account.email.as_deref())
                    .is_some_and(|(new_email, old_email)| new_email.eq_ignore_ascii_case(old_email))
            })
        });
    let account_id = existing
        .map(|account| account.account_id.clone())
        .unwrap_or(proposed_account_id);
    let label = email
        .clone()
        .unwrap_or_else(|| short_account_id(&account_id));
    let refresh_token = response
        .refresh_token
        .ok_or_else(|| "Claude OAuth response did not include a refresh token".to_string())?;
    let now_ms = Utc::now().timestamp_millis();
    let tokens = StoredTokens {
        access_token: response.access_token,
        refresh_token,
        expires_at_ms: oauth_login::expires_at_ms_from(response.expires_in, now_ms),
        scope: response.scope,
    };
    let meta = UsageAccountMeta {
        account_id: account_id.clone(),
        label,
        email,
        enabled: existing.map(|account| account.enabled).unwrap_or(true),
        created_at: existing
            .map(|account| account.created_at.clone())
            .unwrap_or_else(|| Utc::now().to_rfc3339()),
        needs_reauth: false,
    };

    token_store::store_tokens(&account_id, &tokens)?;
    token_store::upsert_account(app, meta.clone())?;
    state.pending_logins.lock().await.remove(&login_id);
    Ok(meta)
}

#[tauri::command]
pub async fn list_usage_accounts(app: tauri::AppHandle) -> Result<Vec<UsageAccountMeta>, String> {
    let mut accounts = token_store::load_accounts(&app)?;
    for account in &mut accounts {
        account.needs_reauth |= matches!(token_store::load_tokens(&account.account_id), Ok(None));
    }
    Ok(accounts)
}

#[tauri::command]
pub async fn remove_usage_account(app: tauri::AppHandle, account_id: String) -> Result<(), String> {
    token_store::delete_tokens(&account_id)?;
    token_store::remove_account_meta(&app, &account_id)
}

#[tauri::command]
pub async fn set_usage_account_enabled(
    app: tauri::AppHandle,
    account_id: String,
    enabled: bool,
) -> Result<(), String> {
    token_store::set_enabled(&app, &account_id, enabled)
}

#[tauri::command]
pub async fn get_multi_usage(
    app: tauri::AppHandle,
    state: tauri::State<'_, UsageOauthState>,
) -> Result<Vec<AccountUsage>, String> {
    let mut accounts = token_store::load_accounts(&app)?;
    for account in &mut accounts {
        account.needs_reauth |= matches!(token_store::load_tokens(&account.account_id), Ok(None));
    }

    let mut output = Vec::with_capacity(accounts.len());
    let mut enabled_seen = false;
    for account in accounts {
        if !account.enabled {
            output.push(empty_account_usage(&account, account.needs_reauth, None));
            continue;
        }

        if enabled_seen {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        enabled_seen = true;

        if account.needs_reauth {
            output.push(empty_account_usage(&account, true, None));
            continue;
        }

        let now_ms = Utc::now().timestamp_millis();
        if let Some(mut cached) = cached_account(&state, &account.account_id, now_ms).await {
            cached.label = account.label.clone();
            cached.email = account.email.clone();
            cached.enabled = true;
            cached.needs_reauth = false;
            output.push(cached);
            continue;
        }

        if let Some(cooldown) = active_cooldown(&state, &account.account_id, now_ms).await {
            output.push(empty_account_usage(
                &account,
                false,
                Some(format!(
                    "Claude usage temporarily paused until {}",
                    rfc3339(cooldown.until_ms)
                )),
            ));
            continue;
        }

        let access_token =
            match oauth_login::ensure_fresh_token(&app, &state, &account.account_id).await {
                Ok(access_token) => access_token,
                Err(error) => {
                    let needs_reauth = persisted_needs_reauth(&app, &account.account_id)
                        .unwrap_or(account.needs_reauth);
                    output.push(empty_account_usage(
                        &account,
                        needs_reauth,
                        (!needs_reauth).then_some(error),
                    ));
                    continue;
                }
            };

        match oauth_claude::fetch_with_token_status(&state.http, &access_token).await {
            Ok(usage) => {
                let fetched_at_ms = Utc::now().timestamp_millis();
                let account_usage = AccountUsage {
                    account_id: account.account_id.clone(),
                    label: account.label.clone(),
                    email: account.email.clone(),
                    enabled: true,
                    needs_reauth: false,
                    five_hour: usage.five_hour,
                    seven_day: usage.seven_day,
                    seven_day_sonnet: usage.seven_day_sonnet,
                    seven_day_opus: usage.seven_day_opus,
                    error: None,
                    fetched_at: rfc3339(fetched_at_ms),
                };
                state.usage_cache.lock().await.insert(
                    account.account_id.clone(),
                    CachedUsage {
                        account: account_usage.clone(),
                        fetched_at_ms,
                    },
                );
                state.cooldowns.lock().await.remove(&account.account_id);
                output.push(account_usage);
            }
            Err((Some(429), error)) => {
                apply_429_cooldown(&state, &account.account_id, Utc::now().timestamp_millis())
                    .await;
                output.push(empty_account_usage(&account, false, Some(error)));
            }
            Err((_, error)) => {
                output.push(empty_account_usage(&account, false, Some(error)));
            }
        }
    }

    Ok(output)
}

pub(crate) async fn apply_429_cooldown(state: &UsageOauthState, account_id: &str, now_ms: i64) {
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

async fn cached_account(
    state: &UsageOauthState,
    account_id: &str,
    now_ms: i64,
) -> Option<AccountUsage> {
    state
        .usage_cache
        .lock()
        .await
        .get(account_id)
        .filter(|cached| now_ms.saturating_sub(cached.fetched_at_ms) < USAGE_CACHE_TTL_MS)
        .map(|cached| cached.account.clone())
}

async fn active_cooldown(
    state: &UsageOauthState,
    account_id: &str,
    now_ms: i64,
) -> Option<Cooldown> {
    state
        .cooldowns
        .lock()
        .await
        .get(account_id)
        .copied()
        .filter(|cooldown| now_ms < cooldown.until_ms)
}

fn persisted_needs_reauth(app: &tauri::AppHandle, account_id: &str) -> Option<bool> {
    token_store::load_accounts(app)
        .ok()?
        .into_iter()
        .find(|account| account.account_id == account_id)
        .map(|account| account.needs_reauth)
}

fn empty_account_usage(
    account: &UsageAccountMeta,
    needs_reauth: bool,
    error: Option<String>,
) -> AccountUsage {
    AccountUsage {
        account_id: account.account_id.clone(),
        label: account.label.clone(),
        email: account.email.clone(),
        enabled: account.enabled,
        needs_reauth,
        five_hour: None,
        seven_day: None,
        seven_day_sonnet: None,
        seven_day_opus: None,
        error,
        fetched_at: Utc::now().to_rfc3339(),
    }
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn short_account_id(account_id: &str) -> String {
    account_id.chars().take(8).collect()
}

fn rfc3339(timestamp_ms: i64) -> String {
    chrono::DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .map(|timestamp| timestamp.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    const CLAUDE_JSON: &str = include_str!("../cli_accounts/fixtures/claude_json_sample.json");
    const CODEX_AUTH: &str = include_str!("../cli_accounts/fixtures/codex_auth_sample.json");

    #[test]
    fn identity_stamp_matches_existing_live_readers() {
        let dir = tempdir().unwrap();
        let claude_paths = ClaudePaths {
            credentials: dir.path().join("credentials.json"),
            claude_json: dir.path().join("claude.json"),
        };
        let codex_paths = CodexPaths {
            auth: dir.path().join("auth.json"),
        };
        fs::write(&claude_paths.claude_json, CLAUDE_JSON).unwrap();
        fs::write(&codex_paths.auth, CODEX_AUTH).unwrap();

        let stamp = read_usage_identity_stamp(Some(&claude_paths), Some(&codex_paths));

        assert_eq!(
            stamp,
            UsageIdentityStamp {
                claude_identity_key: Some("claude-account-a".into()),
                claude_email: Some("a@example.test".into()),
                codex_identity_key: Some("codex-account-a".into()),
                codex_email: Some("codex@example.test".into()),
            }
        );
    }

    #[test]
    fn identity_stamp_returns_none_without_failing_summary() {
        let dir = tempdir().unwrap();
        let claude_paths = ClaudePaths {
            credentials: dir.path().join("missing-credentials.json"),
            claude_json: dir.path().join("invalid-claude.json"),
        };
        let codex_paths = CodexPaths {
            auth: dir.path().join("invalid-codex.json"),
        };
        fs::write(&claude_paths.claude_json, "not-json").unwrap();
        fs::write(&codex_paths.auth, "not-json").unwrap();

        let identity = read_usage_identity_stamp(Some(&claude_paths), Some(&codex_paths));
        assert_eq!(identity, UsageIdentityStamp::default());

        let summary = stamp_usage_summary(
            UsageSummary {
                claude_5h: Some(crate::usage::WindowStat {
                    pct: 42.0,
                    resets_at: "reset".into(),
                }),
                claude_7d: None,
                claude_7d_sonnet: None,
                claude_7d_opus: None,
                codex_5h: None,
                codex_7d: None,
                claude_available: true,
                codex_available: false,
                claude_error: None,
                codex_error: None,
                claude_identity_key: Some("must-be-cleared".into()),
                claude_email: Some("must-be-cleared@example.test".into()),
                codex_identity_key: None,
                codex_email: None,
                generated_at: "generated".into(),
            },
            identity,
        );

        assert_eq!(
            summary.claude_5h.as_ref().map(|window| window.pct),
            Some(42.0)
        );
        assert!(summary.claude_available);
        assert_eq!(summary.generated_at, "generated");
        assert!(summary.claude_identity_key.is_none());
        assert!(summary.claude_email.is_none());
    }

    #[test]
    fn identity_stamp_is_discarded_when_account_changes_during_fetch() {
        let before = UsageIdentityStamp {
            claude_identity_key: Some("account-a".into()),
            claude_email: Some("a@example.test".into()),
            ..UsageIdentityStamp::default()
        };
        let after = UsageIdentityStamp {
            claude_identity_key: Some("account-b".into()),
            claude_email: Some("b@example.test".into()),
            ..UsageIdentityStamp::default()
        };

        assert_eq!(
            stable_usage_identity_stamp(before, after),
            UsageIdentityStamp::default()
        );
    }
}
