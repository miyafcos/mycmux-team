//! In-memory, non-secret evidence scoped to a PTY, never a persisted tab or environment.
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};
use serde::Serialize;
use super::{account_homes, launch_tokens::{self, LaunchTokenStatus, OwnerCheckStatus}, CliProvider};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceMethod { ClaudeLaunchToken, AccountHome }

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceResult { Verified, OrgMatched, OrgShared, Unverified, Mismatch, Matched, Stale }
impl From<&OwnerCheckStatus> for EvidenceResult {
    fn from(status: &OwnerCheckStatus) -> Self {
        match status {
            OwnerCheckStatus::Verified => Self::Verified,
            OwnerCheckStatus::OrgMatched => Self::OrgMatched,
            OwnerCheckStatus::OrgShared => Self::OrgShared,
            OwnerCheckStatus::Unverified => Self::Unverified,
            OwnerCheckStatus::Mismatch => Self::Mismatch,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct TabAccountEvidence {
    pub provider: CliProvider,
    pub profile_id: String,
    pub method: EvidenceMethod,
    pub result: EvidenceResult,
    pub checked_at: String,
    pub launched_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_check_status: Option<u16>,
}

/// Token persistence is independent of the requesting PTY's final evidence read.
pub struct TabRecheckOutcome {
    pub token_record_saved_for: Option<String>,
    pub result: Result<Option<TabAccountEvidence>, String>,
}

impl TabAccountEvidence {
    pub fn claude(status: &LaunchTokenStatus) -> Self {
        Self { provider: CliProvider::Claude, profile_id: status.profile_id.clone(),
            method: EvidenceMethod::ClaudeLaunchToken, result: (&status.owner_check).into(),
            checked_at: status.owner_checked_at.clone().unwrap_or_else(|| status.registered_at.clone()),
            launched_at: chrono::Utc::now().to_rfc3339(), fingerprint: Some(status.fingerprint.clone()),
            owner_email: None, owner_method: status.owner_method.clone(), owner_check_status: status.owner_check_status }
    }
    pub fn home(context: &account_homes::AccountLaunchContext) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self { provider: context.provider, profile_id: context.profile_id.clone(),
            method: EvidenceMethod::AccountHome, result: EvidenceResult::Matched,
            checked_at: context.owner_checked_at.clone().unwrap_or_else(|| now.clone()),
            launched_at: now, fingerprint: None, owner_email: context.owner_email.clone(), owner_method: None, owner_check_status: None }
    }
}
type Records = HashMap<(PathBuf, String), TabAccountEvidence>;
fn records() -> std::sync::MutexGuard<'static, Records> {
    static RECORDS: OnceLock<Mutex<Records>> = OnceLock::new();
    RECORDS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|error| error.into_inner())
}
fn prune(records: &mut Records, base: &Path, alive: &impl Fn(&str) -> bool) {
    records.retain(|(record_base, id), _| record_base != base || alive(id));
}
pub fn remember(base: &Path, session_id: &str, evidence: TabAccountEvidence, alive: impl Fn(&str) -> bool) {
    let mut records = records();
    prune(&mut records, base, &alive);
    if alive(session_id) { records.insert((base.to_path_buf(), session_id.into()), evidence); }
}
pub fn get(base: &Path, session_id: &str, alive: impl Fn(&str) -> bool) -> Result<Option<TabAccountEvidence>, String> {
    let mut evidence = {
        let mut records = records();
        prune(&mut records, base, &alive);
        let Some(evidence) = records.get(&(base.to_path_buf(), session_id.into())).cloned() else { return Ok(None) };
        evidence
    };
    if evidence.method == EvidenceMethod::ClaudeLaunchToken {
        let current = launch_tokens::status_all(base)?.into_iter().find(|status| status.profile_id == evidence.profile_id);
        apply_current_token(&mut evidence, current.as_ref());
    }
    Ok(Some(evidence))
}
fn apply_current_token(evidence: &mut TabAccountEvidence, current: Option<&LaunchTokenStatus>) {
    match current {
        Some(current) if evidence.fingerprint.as_deref() == Some(&current.fingerprint) => {
            evidence.result = (&current.owner_check).into();
            evidence.checked_at = current.owner_checked_at.clone().unwrap_or_else(|| current.registered_at.clone());
            evidence.owner_method = current.owner_method.clone();
            evidence.owner_check_status = current.owner_check_status;
        }
        _ => evidence.result = EvidenceResult::Stale,
    }
}
pub fn recheck(
    base: &Path, session_id: &str, alive: impl Fn(&str) -> bool,
    check_token: impl FnOnce(&str) -> Result<LaunchTokenStatus, String>,
) -> Result<Option<TabAccountEvidence>, String> {
    recheck_with(base, session_id, alive, check_token,
        |provider, id| account_homes::recheck_owner(base, provider, id))
}
pub fn recheck_with_outcome(
    base: &Path, session_id: &str, alive: impl Fn(&str) -> bool,
    check_token: impl FnOnce(&str) -> Result<LaunchTokenStatus, String>,
) -> TabRecheckOutcome {
    recheck_with_outcome_and_home(base, session_id, alive, check_token,
        |provider, id| account_homes::recheck_owner(base, provider, id))
}
fn recheck_with(
    base: &Path, session_id: &str, alive: impl Fn(&str) -> bool,
    check_token: impl FnOnce(&str) -> Result<LaunchTokenStatus, String>,
    check_home: impl FnOnce(CliProvider, &str) -> Result<Option<String>, String>,
) -> Result<Option<TabAccountEvidence>, String> {
    recheck_with_outcome_and_home(base, session_id, alive, check_token, check_home).result
}
fn recheck_with_outcome_and_home(
    base: &Path, session_id: &str, alive: impl Fn(&str) -> bool,
    check_token: impl FnOnce(&str) -> Result<LaunchTokenStatus, String>,
    check_home: impl FnOnce(CliProvider, &str) -> Result<Option<String>, String>,
) -> TabRecheckOutcome {
    let mut token_record_saved_for = None;
    let result = (|| {
        let Some(mut evidence) = get(base, session_id, &alive)? else { return Ok(None) };
        if evidence.method == EvidenceMethod::ClaudeLaunchToken {
            check_token(&evidence.profile_id)?;
            token_record_saved_for = Some(evidence.profile_id);
            return get(base, session_id, alive);
        }
        match check_home(evidence.provider, &evidence.profile_id) {
            Ok(email) => { evidence.result = EvidenceResult::Matched; evidence.owner_email = email; }
            Err(error) if error == account_homes::ERR_HOME_OWNER_MISMATCH => {
                evidence.result = EvidenceResult::Mismatch; evidence.owner_email = None;
            }
            Err(error) => return Err(error),
        }
        evidence.checked_at = chrono::Utc::now().to_rfc3339();
        {
            let mut records = records();
            prune(&mut records, base, &alive);
            if let Some(current) = records.get_mut(&(base.to_path_buf(), session_id.into())) {
                if current.launched_at == evidence.launched_at && current.profile_id == evidence.profile_id { *current = evidence; }
            }
        }
        get(base, session_id, alive)
    })();
    TabRecheckOutcome { token_record_saved_for, result }
}

#[cfg(test)]
#[path = "tab_evidence_tests.rs"]
mod tests;
