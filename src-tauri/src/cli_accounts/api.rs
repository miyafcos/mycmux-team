//! API policy around the unchanged, owner-aware PC switch executor.
use super::*;

pub const ERR_SWITCH_BUSY: &str = "cli_account.error.switch_busy";
pub const ALREADY_ACTIVE: &str = "cli_account.result.already_active";

#[derive(Default)]
pub(crate) struct ProviderActivity(Mutex<[usize; 3]>);

fn provider_index(provider: CliProvider) -> usize {
    match provider {
        CliProvider::Claude => 0,
        CliProvider::Codex => 1,
        CliProvider::Grok => 2,
    }
}

pub(crate) struct SwitchActivity<'a> {
    activity: &'a ProviderActivity,
    provider: CliProvider,
}

impl ProviderActivity {
    // PC calls are observed, never rejected or queued by this bookkeeping.
    fn enter(&self, provider: CliProvider, api_request: bool) -> Result<SwitchActivity<'_>, String> {
        let mut counts = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let count = &mut counts[provider_index(provider)];
        if api_request && *count != 0 {
            return Err(ERR_SWITCH_BUSY.into());
        }
        *count += 1;
        Ok(SwitchActivity { activity: self, provider })
    }
}

impl Drop for SwitchActivity<'_> {
    fn drop(&mut self) {
        let mut counts = self.activity.0.lock().unwrap_or_else(|error| error.into_inner());
        counts[provider_index(self.provider)] -= 1;
    }
}

pub(crate) fn switch_activity(provider: CliProvider, api_request: bool) -> Result<SwitchActivity<'static>, String> {
    static ACTIVITY: OnceLock<ProviderActivity> = OnceLock::new();
    ACTIVITY.get_or_init(ProviderActivity::default).enter(provider, api_request)
}

/// Read-only membership / known-health check, before any token prewarming.
pub(crate) fn preflight_target(base: &Path, provider: CliProvider, profile_id: &str) -> Result<CliAccountProfile, String> {
    snapshot::validate_snapshot_id(profile_id).map_err(|_| ERR_PROFILE_NOT_FOUND.to_string())?;
    let file = registry::load(base).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let target = file.profiles.iter()
        .find(|profile| profile.provider == provider && profile.id == profile_id)
        .ok_or_else(|| ERR_PROFILE_NOT_FOUND.to_string())?;
    let target = refreshed_profiles(base, std::slice::from_ref(target)).remove(0);
    if target.needs_relogin {
        return Err(ERR_NEEDS_RELOGIN.into());
    }
    Ok(target)
}

/// API-only no-op gate. Read credentials without rotating tokens or changing
/// the provider identity readers / PC write-back order. Bind health and name
/// to the same document so a CLI rotation between reads cannot prove a no-op.
fn live_credentials_healthy(
    provider: CliProvider, identity: &str, codex_paths: &codex::CodexPaths,
    grok_paths: &grok::GrokPaths,
) -> bool {
    use crate::usage::credentials::{self, TokenPlan};
    let now_ms = Utc::now().timestamp_millis();
    let usable = |expiry| credentials::plan_token_source(true, expiry, None, now_ms) == TokenPlan::UseLive;
    match provider {
        // Claude has its existing credentials + verified-owner gate below.
        CliProvider::Claude => true,
        CliProvider::Codex => (|| {
            let text = fs::read_to_string(&codex_paths.auth).ok()?;
            let tokens = credentials::codex_tokens(&text).ok()?;
            if !usable(tokens.access_expires_at_ms) { return None; }
            let value: serde_json::Value = serde_json::from_str(&text).ok()?;
            let claims = value.pointer("/tokens/id_token").and_then(serde_json::Value::as_str)
                .map(codex::decode_id_token_claims).transpose().ok()?;
            let current = claims.and_then(|claims| claims.account_id).or(tokens.account_id);
            (current.as_deref() == Some(identity)).then_some(())
        })().is_some(),
        CliProvider::Grok => (|| {
            let text = fs::read_to_string(&grok_paths.auth).ok()?;
            let tokens = credentials::grok_tokens(&text).ok()?;
            let value: serde_json::Value = serde_json::from_str(&text).ok()?;
            let entry = value.as_object()?.values().find_map(serde_json::Value::as_object)?;
            if entry.get("user_id").and_then(serde_json::Value::as_str) != Some(identity) { return None; }
            let jwt_expiry = codex::decode_id_token_claims(&tokens.access_token).ok()
                .and_then(|claims| claims.expires_at_ms);
            // The refresh writer replaces the key while retaining expires_at.
            // A JWT's expiry belongs to this key; file metadata is a fallback
            // only when the current key supplies no expiry of its own.
            let expiry = match jwt_expiry {
                Some(expiry) => Some(expiry),
                None => match entry.get("expires_at") {
                    None | Some(serde_json::Value::Null) => None,
                    Some(value) => Some(chrono::DateTime::parse_from_rfc3339(value.as_str()?).ok()?.timestamp_millis()),
                },
            };
            usable(expiry).then_some(())
        })().is_some(),
    }
}

pub(crate) fn switch_with_paths(
    base: &Path,
    claude_paths: &claude::ClaudePaths,
    codex_paths: &codex::CodexPaths,
    grok_paths: &grok::GrokPaths,
    provider: CliProvider,
    profile_id: &str,
    lookup: OwnerLookup,
) -> Result<CliSwitchResult, String> {
    // The resolved caller holds the same mutation lock as the PC path. Recheck
    // membership and health here: they may have changed during prewarming.
    let target = preflight_target(base, provider, profile_id)?;
    if provider == CliProvider::Codex {
        codex::ensure_file_credentials_store(codex_paths)?;
    }
    let live = match provider {
        CliProvider::Claude => claude::read_live_identity(claude_paths),
        CliProvider::Codex => codex::read_live_identity(codex_paths),
        CliProvider::Grok => grok::read_live_identity(grok_paths),
    };
    let healthy = live.present && live.error.is_none()
        && live.identity_key.as_deref() == Some(target.identity_key.as_str());
    let owner_verified = provider != CliProvider::Claude || claude::read_credentials(claude_paths)
        .filter(|text| !claude::needs_relogin(text))
        .and_then(|text| token_owner::claude_access_token(&text))
        .and_then(|token| lookup(&token))
        .is_some_and(|owner| owner.account_uuid == target.identity_key);
    if healthy && owner_verified
        && live_credentials_healthy(provider, &target.identity_key, codex_paths, grok_paths) {
        return Err(ALREADY_ACTIVE.into());
    }
    // Exactly the PC implementation: write-back, owner filing, backup,
    // provider restore, identity check and registry update stay in one place.
    switch_account_with_grok(base, claude_paths, codex_paths, Some(grok_paths), provider, profile_id, lookup)
        .map_err(|error| format!("cli_account.api.core_error:{error}"))
}

pub(crate) fn switch_resolved(base: &Path, provider: CliProvider, profile_id: &str) -> Result<CliSwitchResult, String> {
    let _guard = mutation_guard()?;
    let claude_paths = claude::ClaudePaths::resolve()?;
    let codex_paths = codex::CodexPaths::resolve()?;
    let grok_paths = grok::GrokPaths::resolve()?;
    switch_with_paths(base, &claude_paths, &codex_paths, &grok_paths, provider, profile_id, &token_owner::cached_owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_switch_activity_poison_does_not_refuse_pc_calls() {
        let activity = ProviderActivity::default();
        let panic = std::panic::catch_unwind(|| {
            let _guard = activity.0.lock().unwrap();
            panic!("synthetic bookkeeping panic");
        });
        assert!(panic.is_err());
        let pc = activity.enter(CliProvider::Claude, false).unwrap();
        assert!(activity.enter(CliProvider::Claude, true).is_err());
        drop(pc);
        assert!(activity.enter(CliProvider::Claude, true).is_ok());
    }

    #[test]
    fn api_switch_activity_observes_pc_and_releases_each_reservation() {
        let activity = ProviderActivity::default();
        let pc = activity.enter(CliProvider::Claude, false).unwrap();
        assert_eq!(activity.enter(CliProvider::Claude, true).err(), Some(ERR_SWITCH_BUSY.into()));
        let other = activity.enter(CliProvider::Codex, true).unwrap();
        let second_pc = activity.enter(CliProvider::Claude, false).unwrap();
        drop(pc);
        assert!(activity.enter(CliProvider::Claude, true).is_err());
        drop(second_pc);
        let api = activity.enter(CliProvider::Claude, true).unwrap();
        assert!(activity.enter(CliProvider::Claude, true).is_err());
        drop(api);
        drop(other);
        assert!(activity.enter(CliProvider::Claude, true).is_ok());
        assert!(activity.enter(CliProvider::Codex, true).is_ok());
    }
}
