use super::*;
use std::{cell::RefCell, collections::HashMap};
use super::super::CliAccountProfile;
use super::super::token_owner::TokenOwner;

#[derive(Default)]
struct MemorySecrets(RefCell<HashMap<String, String>>);
impl LaunchTokenStore for MemorySecrets {
    fn read(&self, id: &str) -> Result<Option<String>, String> { Ok(self.0.borrow().get(id).cloned()) }
    fn write(&self, id: &str, token: &str) -> Result<(), String> { self.0.borrow_mut().insert(id.into(), token.into()); Ok(()) }
    fn delete(&self, id: &str) -> Result<(), String> { self.0.borrow_mut().remove(id); Ok(()) }
}
// Preserve the original tests' profile-only fixtures; new tests exercise both stages.
fn save(base: &Path, secrets: &dyn LaunchTokenStore, id: &str, token: &str,
    lookup: impl FnOnce(&str) -> OwnerCheck) -> Result<LaunchTokenStatus, String> {
    super::save(base, secrets, id, token, |token| lookup(token).into())
}
const ID: &str = "claude-1a2b3c4d";
fn token() -> String { format!("sk-ant-oat01-{}", "a".repeat(32)) }
fn owner(id: &str) -> OwnerCheck {
    OwnerCheck::Owner(TokenOwner { account_uuid: id.into(), email: None, organization_uuid: None })
}
fn fixture() -> (tempfile::TempDir, MemorySecrets) {
    let dir = tempfile::tempdir().unwrap();
    let profile = CliAccountProfile {
        id: ID.into(), provider: CliProvider::Claude, identity_key: "owner-1".into(), label: "fixture".into(),
        email: None, plan: None, org_name: None, captured_at: Utc::now().to_rfc3339(),
        last_switched_at: None, needs_relogin: false, refresh_rejected_at: None, foreign_token_owner: None,
    };
    registry::save(dir.path(), &registry::CliAccountsFile { profiles: vec![profile], ..Default::default() }).unwrap();
    (dir, MemorySecrets::default())
}

#[test]
fn registration_roundtrips_secret_and_non_secret_status() {
    let (dir, secrets) = fixture();
    let value = token();
    let record = save(dir.path(), &secrets, ID, &value, |_| owner("owner-1")).unwrap();
    assert_eq!(load_token(&secrets, ID).unwrap(), Some(value.clone()));
    assert_eq!(record.profile_id, ID);
    let registered = DateTime::parse_from_rfc3339(&record.registered_at).unwrap();
    let expires = DateTime::parse_from_rfc3339(&record.expires_at).unwrap();
    assert_eq!(expires - registered, Duration::days(365));
    assert_eq!(record.owner_check, OwnerCheckStatus::Verified);
    assert_eq!(record.owner_check_status, None);
    assert_eq!(record.fingerprint, hex::encode(Sha256::digest(value.as_bytes()))[..10]);
    assert_eq!(status_all(dir.path()).unwrap(), vec![record]);
    let json = fs::read_to_string(dir.path().join(FILE)).unwrap();
    assert!(!json.contains(&value));
    assert!(!json.contains("sk-ant-"));
    assert!(!json.contains("owner_check_status"));
    assert!(serde_json::from_str::<serde_json::Value>(&json).unwrap()[0].get("token").is_none());
}

#[test]
fn token_shape_rejects_invalid_values_before_lookup_or_write() {
    let (dir, secrets) = fixture();
    let values = [String::new(), format!("sk-ant-oat01-{} {}", "a".repeat(20), "b".repeat(20)),
        format!("sk-ant-other01-{}", "a".repeat(32)), format!("sk-ant-oat01-{}", "a".repeat(19)),
        format!("sk-ant-oat01-{}", "a".repeat(513)), format!("sk-ant-oat01-{}!", "a".repeat(32)),
        format!("sk-ant-oat1-{}", "a".repeat(32)), format!("sk-ant-oatAA-{}", "a".repeat(32))];
    for value in values {
        let error = save(dir.path(), &secrets, ID, &value, |_| panic!("lookup must not run")).unwrap_err();
        assert_eq!(error, ERR_LAUNCH_TOKEN_INVALID);
        assert!(!error.contains("sk-ant-"));
    }
    assert!(secrets.0.borrow().is_empty());
    assert!(!dir.path().join(FILE).exists());
    for length in [20, 512] {
        let value = format!("sk-ant-oat99-{}", "_-a9".repeat(128)[..length].to_owned());
        assert_eq!(normalized_token(&value).unwrap(), value);
    }
    let value = token();
    save(dir.path(), &secrets, ID, &format!(" \r\n{value}\n\t"), |clean| {
        assert_eq!(clean, value);
        OwnerCheck::Unavailable
    }).unwrap();
    assert_eq!(load_token(&secrets, ID).unwrap(), Some(value));
}

#[test]
fn lookup_mismatch_never_writes_and_unverifiable_responses_can_register() {
    let (dir, secrets) = fixture();
    let error = save(dir.path(), &secrets, ID, &token(), |_| owner("different-owner")).unwrap_err();
    assert_eq!(error, ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    assert!(secrets.0.borrow().is_empty());
    assert!(!dir.path().join(FILE).exists());
    for (check, status) in [(OwnerCheck::Rejected { status: 401 }, Some(401)),
        (OwnerCheck::Rejected { status: 403 }, Some(403)),
        (OwnerCheck::RateLimited { retry_after_secs: Some(60) }, Some(429)), (OwnerCheck::Unavailable, None)] {
        let record = save(dir.path(), &secrets, ID, &token(), |_| check).unwrap();
        assert_eq!(record.owner_check, OwnerCheckStatus::Unverified);
        assert_eq!(record.owner_check_status, status);
        assert_eq!(status_all(dir.path()).unwrap().len(), 1);
    }
}

#[test]
fn registry_and_id_validation_precede_secret_access() {
    let (dir, secrets) = fixture();
    let mut file = registry::load(dir.path()).unwrap();
    let mut codex = file.profiles[0].clone();
    codex.id = "codex-12345678".into();
    codex.provider = CliProvider::Codex;
    file.profiles.push(codex);
    registry::save(dir.path(), &file).unwrap();
    for id in ["claude-absent", "codex-12345678", "../../escape", "claude-../../escape", "", "wrong-prefix"] {
        assert_eq!(save(dir.path(), &secrets, id, &token(), |_| panic!("lookup must not run")).unwrap_err(), ERR_LAUNCH_ACCOUNT_NOT_FOUND);
    }
    assert!(secrets.0.borrow().is_empty());
    assert!(!dir.path().join(FILE).exists());
}

#[test]
fn reregistration_replaces_secret_and_status_and_remove_is_idempotent() {
    let (dir, secrets) = fixture();
    save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    let replacement = format!("sk-ant-oat02-{}", "b".repeat(40));
    let updated = save(dir.path(), &secrets, ID, &replacement, |_| OwnerCheck::Rejected { status: 403 }).unwrap();
    assert_eq!(load_token(&secrets, ID).unwrap(), Some(replacement));
    assert_eq!(status_all(dir.path()).unwrap(), vec![updated]);
    remove(dir.path(), &secrets, ID).unwrap();
    assert_eq!(load_token(&secrets, ID).unwrap(), None);
    assert!(status_all(dir.path()).unwrap().is_empty());
    remove(dir.path(), &secrets, ID).unwrap();
    remove(dir.path(), &secrets, "claude-absent").unwrap();
}

#[test]
fn remove_resolved_removes_the_linked_secret_without_relocking_mutation_guard() {
    let (dir, secrets) = fixture();
    save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    super::super::remove_resolved_with_launch_store(dir.path(), ID, &secrets).unwrap();
    assert!(registry::load(dir.path()).unwrap().profiles.is_empty());
    assert_eq!(load_token(&secrets, ID).unwrap(), None);
    assert!(status_all(dir.path()).unwrap().is_empty());
}

#[test]
fn storage_failures_return_fixed_errors_without_secret_text() {
    struct Failing;
    impl LaunchTokenStore for Failing {
        fn read(&self, _: &str) -> Result<Option<String>, String> { Err(token()) }
        fn write(&self, _: &str, _: &str) -> Result<(), String> { Err(token()) }
        fn delete(&self, _: &str) -> Result<(), String> { Err(token()) }
    }
    let (dir, _) = fixture();
    let errors = [save(dir.path(), &Failing, ID, &token(), |_| OwnerCheck::Unavailable).unwrap_err(),
        load_token(&Failing, ID).unwrap_err(), remove(dir.path(), &Failing, ID).unwrap_err()];
    assert_eq!(errors, [ERR_REGISTRY_SAVE_FAILED, ERR_SNAPSHOT_UNAVAILABLE, ERR_REMOVE_FAILED]);
    for error in errors { assert!(error.starts_with("cli_account.error.")); assert!(!error.contains("sk-ant-")); }
    assert!(status_all(dir.path()).unwrap().is_empty());
}


fn organization(base: &Path, id: &str, org: Option<&str>) {
    let account = serde_json::json!({"organizationUuid": org});
    let metadata = serde_json::json!({"oauth_account_text": account.to_string(),
        "credentials_text": "deliberately not credentials JSON"});
    fs::create_dir_all(snapshot::snapshot_dir(base)).unwrap();
    fs::write(snapshot::snapshot_dir(base).join(format!("{id}.json")), metadata.to_string()).unwrap();
}
fn org_check(org: &str) -> LaunchOwnerCheck {
    LaunchOwnerCheck { profile: OwnerCheck::Rejected { status: 403 },
        organization: Some(OrganizationCheck::Organization(org.into())) }
}

#[test]
fn v1_organization_match_shared_mismatch_and_unknown_metadata() {
    let (dir, secrets) = fixture();
    organization(dir.path(), ID, Some("org-1"));
    let record = super::save(dir.path(), &secrets, ID, &token(), |_| org_check("org-1")).unwrap();
    assert_eq!(record.owner_check, OwnerCheckStatus::OrgMatched);
    assert_eq!(record.owner_method.as_deref(), Some("org"));
    assert!(DateTime::parse_from_rfc3339(record.owner_checked_at.as_deref().unwrap()).is_ok());
    let mut file = registry::load(dir.path()).unwrap();
    let mut other = file.profiles[0].clone();
    other.id = "claude-other".into(); other.identity_key = "owner-2".into();
    file.profiles.push(other);
    registry::save(dir.path(), &file).unwrap();
    organization(dir.path(), "claude-other", Some("org-1"));
    let record = super::save(dir.path(), &secrets, ID, &token(), |_| org_check("org-1")).unwrap();
    assert_eq!(record.owner_check, OwnerCheckStatus::OrgShared);
    let before = status_all(dir.path()).unwrap();
    let replacement = format!("sk-ant-oat02-{}", "b".repeat(32));
    assert_eq!(super::save(dir.path(), &secrets, ID, &replacement, |_| org_check("other-org")).unwrap_err(), ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    assert_eq!(status_all(dir.path()).unwrap(), before);
    assert_eq!(load_token(&secrets, ID).unwrap(), Some(token()));
    for missing in [None, Some("")] {
        organization(dir.path(), ID, missing);
        assert_eq!(super::save(dir.path(), &secrets, ID, &token(), |_| org_check("org-1")).unwrap().owner_check, OwnerCheckStatus::Unverified);
    }
    let no_snapshot = "claude-missing";
    file.profiles[0].id = no_snapshot.into();
    registry::save(dir.path(), &file).unwrap();
    assert_eq!(super::save(dir.path(), &secrets, no_snapshot, &token(), |_| org_check("org-1")).unwrap().owner_check, OwnerCheckStatus::Unverified);
}

#[test]
fn v1_profile_takes_priority_and_unavailable_org_retains_only_status() {
    let (dir, secrets) = fixture();
    organization(dir.path(), ID, Some("org-1"));
    let result = super::save(dir.path(), &secrets, ID, &token(), |received| {
        assert_eq!(received, token());
        LaunchOwnerCheck { profile: owner("owner-1"), organization: Some(OrganizationCheck::Organization("different-org".into())) }
    }).unwrap();
    assert_eq!(result.owner_check, OwnerCheckStatus::Verified);
    assert_eq!(result.owner_method.as_deref(), Some("profile"));
    for failed in [OwnerCheck::Unavailable, OwnerCheck::RateLimited { retry_after_secs: Some(10) }, OwnerCheck::Rejected { status: 401 }] {
        let result = super::save(dir.path(), &secrets, ID, &token(), |received| {
            assert_eq!(received, token());
            LaunchOwnerCheck { profile: failed, organization: Some(OrganizationCheck::Unavailable { status: Some(503) }) }
        }).unwrap();
        assert_eq!(result.owner_check, OwnerCheckStatus::Unverified);
        assert_eq!(result.owner_check_status, Some(503));
        assert_eq!(result.owner_method, None);
        for text in [serde_json::to_string(&result).unwrap(), format!("{result:?}"), fs::read_to_string(dir.path().join(FILE)).unwrap()] {
            assert!(!text.contains(&token()));
        }
    }
}

#[test]
fn v1_legacy_verified_and_unverified_records_default_new_fields() {
    for status in ["verified", "unverified"] {
        let json = serde_json::json!({"profile_id": ID, "registered_at": "2026-01-01T00:00:00Z",
            "expires_at": "2027-01-01T00:00:00Z", "owner_check": status, "fingerprint": "1234567890"});
        let record: LaunchTokenStatus = serde_json::from_value(json).unwrap();
        assert_eq!(record.owner_checked_at, None);
        assert_eq!(record.owner_method, None);
        assert_eq!(serde_json::to_value(&record).unwrap()["owner_check"], status);
    }
    for (value, status) in [("org_matched", OwnerCheckStatus::OrgMatched), ("org_shared", OwnerCheckStatus::OrgShared), ("mismatch", OwnerCheckStatus::Mismatch)] {
        assert_eq!(serde_json::from_str::<OwnerCheckStatus>(&format!("\"{value}\"")).unwrap(), status);
    }
}

#[test]
fn v1_recheck_persists_mismatch_keeps_secret_and_registration_then_blocks_launch() {
    let (dir, secrets) = fixture();
    let initial = save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    let result = recheck(dir.path(), &secrets, ID, |received| {
        assert_eq!(received, token()); owner("other").into()
    }).unwrap();
    assert_eq!(result.owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(result.registered_at, initial.registered_at);
    assert_eq!(result.expires_at, initial.expires_at);
    assert_eq!(result.fingerprint, initial.fingerprint);
    assert_eq!(status_all(dir.path()).unwrap(), vec![result]);
    assert_eq!(load_token(&secrets, ID).unwrap(), Some(token()));
    assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).err().unwrap(), ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    let recovered = recheck(dir.path(), &secrets, ID, |_| owner("owner-1").into()).unwrap();
    assert_eq!(recovered.owner_check, OwnerCheckStatus::Verified);
    assert!(load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().is_some());
    organization(dir.path(), ID, Some("org-1"));
    let mismatch = recheck(dir.path(), &secrets, ID, |_| org_check("other-org")).unwrap();
    assert_eq!(mismatch.owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(mismatch.owner_method.as_deref(), Some("org"));
    assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).err().unwrap(), ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    assert_eq!(load_token(&secrets, ID).unwrap(), Some(token()));
}

#[derive(Default)]
struct FailingDelete(std::cell::Cell<usize>);
impl LaunchTokenStore for FailingDelete {
    fn read(&self, _: &str) -> Result<Option<String>, String> { panic!("remove must not read a token"); }
    fn write(&self, _: &str, _: &str) -> Result<(), String> { panic!("remove must not write a token"); }
    fn delete(&self, _: &str) -> Result<(), String> {
        self.0.set(self.0.get() + 1);
        Err("fixture secret store unavailable".into())
    }
}

#[test]
fn fixr_r07_tokenless_codex_and_grok_unregister_without_touching_the_secret_store() {
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let (dir, _) = fixture();
        let mut file = registry::load(dir.path()).unwrap();
        let id = if provider == CliProvider::Codex { "codex-fixture" } else { "grok-fixture" };
        file.profiles[0].id = id.into(); file.profiles[0].provider = provider;
        registry::save(dir.path(), &file).unwrap();
        // Even malformed Claude metadata is unrelated to these providers.
        fs::write(dir.path().join(FILE), b"not Claude token metadata").unwrap();
        let secrets = FailingDelete::default();
        super::super::remove_resolved_with_launch_store(dir.path(), id, &secrets).unwrap();
        assert!(registry::load(dir.path()).unwrap().profiles.is_empty());
        assert_eq!(secrets.0.get(), 0);
    }
}

#[test]
fn fixr_r07_unrecorded_claude_best_effort_delete_does_not_block_unregister() {
    let (dir, _) = fixture();
    let secrets = FailingDelete::default();
    super::super::remove_resolved_with_launch_store(dir.path(), ID, &secrets).unwrap();
    assert!(registry::load(dir.path()).unwrap().profiles.is_empty());
    assert_eq!(secrets.0.get(), 1);
    assert!(status_all(dir.path()).unwrap().is_empty());
}

#[test]
fn fixr_r07_recorded_claude_delete_failure_keeps_registration_and_metadata() {
    let (dir, memory) = fixture();
    save(dir.path(), &memory, ID, &token(), |_| owner("owner-1")).unwrap();
    let secrets = FailingDelete::default();
    assert_eq!(super::super::remove_resolved_with_launch_store(dir.path(), ID, &secrets).unwrap_err(), ERR_REMOVE_FAILED);
    assert_eq!(secrets.0.get(), 1);
    assert_eq!(registry::load(dir.path()).unwrap().profiles[0].id, ID);
    assert_eq!(status_all(dir.path()).unwrap().len(), 1);
}


fn assert_rv01_recheck(method: Option<&str>, next: LaunchOwnerCheck, shared: bool, expected: OwnerCheckStatus) {
    let (dir, secrets) = fixture();
    organization(dir.path(), ID, Some("org-1"));
    let registered = save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    let mut mismatch = recheck(dir.path(), &secrets, ID, |_| {
        if method == Some("profile") { owner("other-owner").into() } else { org_check("other-org") }
    }).unwrap();
    assert_eq!(mismatch.owner_check, OwnerCheckStatus::Mismatch);
    mismatch.owner_method = method.map(str::to_owned);
    mismatch.owner_checked_at = Some("2026-01-01T00:00:00Z".into());
    save_status(dir.path(), &[mismatch.clone()]).unwrap();
    if shared {
        let mut file = registry::load(dir.path()).unwrap();
        let mut other = file.profiles[0].clone();
        other.id = "claude-shared".into();
        other.identity_key = "owner-2".into();
        file.profiles.push(other);
        registry::save(dir.path(), &file).unwrap();
        organization(dir.path(), "claude-shared", Some("org-1"));
    }
    let status = if matches!(next.organization, Some(OrganizationCheck::Organization(_))) { None } else {
        match &next.profile {
            OwnerCheck::Rejected { status } => Some(*status),
            OwnerCheck::RateLimited { .. } => Some(429),
            _ => None,
        }
    };
    let result = recheck(dir.path(), &secrets, ID, |received| {
        assert_eq!(received, token());
        next
    }).unwrap();
    assert_eq!(result.owner_check, expected);
    assert_eq!(result.registered_at, registered.registered_at);
    assert_eq!(result.expires_at, registered.expires_at);
    assert_eq!(result.fingerprint, registered.fingerprint);
    assert_eq!(load_token(&secrets, ID).unwrap(), Some(token()));
    assert_ne!(result.owner_checked_at, mismatch.owner_checked_at);
    assert_eq!(status_all(dir.path()).unwrap(), vec![result.clone()]);
    if expected == OwnerCheckStatus::Mismatch {
        assert_eq!(result.owner_method, mismatch.owner_method);
        assert_eq!(result.owner_check_status, status);
        assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).err().unwrap(), ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    } else {
        let loaded = load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().unwrap();
        assert_eq!(loaded.token, token());
        assert_eq!(loaded.status.fingerprint, registered.fingerprint);
        assert_eq!(result.owner_method.as_deref(), Some(if expected == OwnerCheckStatus::Verified { "profile" } else { "org" }));
    }
}

fn rv01_unavailable(profile: OwnerCheck) -> LaunchOwnerCheck {
    LaunchOwnerCheck { profile, organization: Some(OrganizationCheck::Unavailable { status: None }) }
}

macro_rules! rv01_case {
    ($name:ident, $method:expr, $next:expr, $shared:expr, $expected:ident) => {
        #[test]
        fn $name() { assert_rv01_recheck($method, $next, $shared, OwnerCheckStatus::$expected); }
    };
}
rv01_case!(rv01_profile_mismatch_survives_unavailable, Some("profile"), rv01_unavailable(OwnerCheck::Unavailable), false, Mismatch);
rv01_case!(rv01_profile_mismatch_survives_403, Some("profile"), rv01_unavailable(OwnerCheck::Rejected { status: 403 }), false, Mismatch);
rv01_case!(rv01_profile_mismatch_survives_429, Some("profile"), rv01_unavailable(OwnerCheck::RateLimited { retry_after_secs: Some(60) }), false, Mismatch);
rv01_case!(rv01_profile_mismatch_survives_shared_org, Some("profile"), org_check("org-1"), true, Mismatch);
rv01_case!(rv01_profile_mismatch_survives_matched_org, Some("profile"), org_check("org-1"), false, Mismatch);
rv01_case!(rv01_profile_mismatch_clears_with_verified_owner, Some("profile"), owner("owner-1").into(), false, Verified);
rv01_case!(rv01_org_mismatch_clears_with_matched_org, Some("org"), org_check("org-1"), false, OrgMatched);
rv01_case!(rv01_org_mismatch_clears_with_verified_owner, Some("org"), owner("owner-1").into(), false, Verified);
rv01_case!(rv01_org_mismatch_survives_shared_org, Some("org"), org_check("org-1"), true, Mismatch);
rv01_case!(rv01_org_mismatch_survives_unavailable, Some("org"), rv01_unavailable(OwnerCheck::Unavailable), false, Mismatch);
rv01_case!(rv01_legacy_mismatch_clears_with_matched_org, None, org_check("org-1"), false, OrgMatched);
rv01_case!(rv01_legacy_mismatch_clears_with_verified_owner, None, owner("owner-1").into(), false, Verified);
rv01_case!(rv01_legacy_mismatch_survives_shared_org, None, org_check("org-1"), true, Mismatch);
rv01_case!(rv01_legacy_mismatch_survives_unavailable, None, rv01_unavailable(OwnerCheck::Unavailable), false, Mismatch);

fn assert_rb02_strongest_mismatch(first_profile: bool) {
    let (dir, secrets) = fixture();
    organization(dir.path(), ID, Some("org-1"));
    let registered = save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    let mut first = recheck(dir.path(), &secrets, ID, |_| {
        if first_profile { owner("other-owner").into() } else { org_check("other-org") }
    }).unwrap();
    assert_eq!(first.owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(first.owner_method.as_deref(), Some(if first_profile { "profile" } else { "org" }));
    first.owner_check_status = Some(429);
    first.owner_checked_at = Some("2026-01-01T00:00:00Z".into());
    save_status(dir.path(), &[first.clone()]).unwrap();
    let mismatch = recheck(dir.path(), &secrets, ID, |_| {
        if first_profile { org_check("other-org") } else { owner("other-owner").into() }
    }).unwrap();
    assert_eq!(mismatch.owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(mismatch.owner_method.as_deref(), Some("profile"));
    assert_eq!(mismatch.owner_check_status, None);
    assert_ne!(mismatch.owner_checked_at, first.owner_checked_at);
    assert_eq!(status_all(dir.path()).unwrap(), vec![mismatch.clone()]);
    assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).err().unwrap(), ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    let still_mismatch = recheck(dir.path(), &secrets, ID, |_| org_check("org-1")).unwrap();
    assert_eq!(still_mismatch.owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(still_mismatch.owner_method.as_deref(), Some("profile"));
    assert_eq!(status_all(dir.path()).unwrap(), vec![still_mismatch.clone()]);
    assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).err().unwrap(), ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    let recovered = recheck(dir.path(), &secrets, ID, |_| owner("owner-1").into()).unwrap();
    assert_eq!(recovered.owner_check, OwnerCheckStatus::Verified);
    assert_eq!(recovered.owner_method.as_deref(), Some("profile"));
    assert_eq!(status_all(dir.path()).unwrap(), vec![recovered.clone()]);
    for record in [&first, &mismatch, &still_mismatch, &recovered] {
        assert_eq!(record.registered_at, registered.registered_at);
        assert_eq!(record.expires_at, registered.expires_at);
        assert_eq!(record.fingerprint, registered.fingerprint);
    }
    assert_eq!(load_token(&secrets, ID).unwrap(), Some(token()));
    let loaded = load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().unwrap();
    assert_eq!(loaded.token, token());
    assert_eq!(loaded.status.fingerprint, registered.fingerprint);
}

#[test]
fn rb02_profile_mismatch_cannot_downgrade_before_recovery() {
    assert_rb02_strongest_mismatch(true);
}

#[test]
fn rb02_org_mismatch_upgrades_to_profile_before_recovery() {
    assert_rb02_strongest_mismatch(false);
}

#[test]
fn rb02_reregistration_starts_from_the_new_token_owner_result() {
    let (dir, secrets) = fixture();
    organization(dir.path(), ID, Some("org-1"));
    let registered = save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    recheck(dir.path(), &secrets, ID, |_| owner("other-owner").into()).unwrap();
    let replacement = format!("sk-ant-oat02-{}", "b".repeat(32));
    let record = super::save(dir.path(), &secrets, ID, &replacement, |_| org_check("org-1")).unwrap();
    assert_eq!(record.owner_check, OwnerCheckStatus::OrgMatched);
    assert_eq!(record.owner_method.as_deref(), Some("org"));
    assert_ne!(record.fingerprint, registered.fingerprint);
    assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().unwrap().token, replacement);
}

#[derive(Default)]
struct ObservedSecrets {
    memory: MemorySecrets,
    reads: std::cell::Cell<usize>,
    writes: std::cell::Cell<usize>,
    deletes: std::cell::Cell<usize>,
    fail_read: bool,
    fail_write: bool,
}
impl LaunchTokenStore for ObservedSecrets {
    fn read(&self, id: &str) -> Result<Option<String>, String> {
        self.reads.set(self.reads.get() + 1);
        if self.fail_read { Err(token()) } else { self.memory.read(id) }
    }
    fn write(&self, id: &str, value: &str) -> Result<(), String> {
        self.writes.set(self.writes.get() + 1);
        if self.fail_write { Err(token()) } else { self.memory.write(id, value) }
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.deletes.set(self.deletes.get() + 1);
        self.memory.delete(id)
    }
}

fn assert_p1001_same_token(
    method: Option<&str>, next: LaunchOwnerCheck, shared: bool,
    expected: OwnerCheckStatus, missing_secret: bool,
) {
    let (dir, memory) = fixture();
    organization(dir.path(), ID, Some("org-1"));
    save(dir.path(), &memory, ID, &token(), |_| owner("owner-1")).unwrap();
    let mut before = recheck(dir.path(), &memory, ID, |_| {
        if method == Some("profile") { owner("other-owner").into() } else { org_check("other-org") }
    }).unwrap();
    before.owner_method = method.map(str::to_owned);
    before.registered_at = "2026-01-01T00:00:00Z".into();
    before.expires_at = "2027-01-01T00:00:00Z".into();
    before.owner_checked_at = Some("2026-01-01T00:00:00Z".into());
    save_status(dir.path(), &[before.clone()]).unwrap();
    if shared {
        let mut file = registry::load(dir.path()).unwrap();
        let mut other = file.profiles[0].clone();
        other.id = "claude-shared".into();
        other.identity_key = "owner-2".into();
        file.profiles.push(other);
        registry::save(dir.path(), &file).unwrap();
        organization(dir.path(), "claude-shared", Some("org-1"));
    }
    if missing_secret { memory.0.borrow_mut().remove(ID); }
    let secrets = ObservedSecrets { memory, ..Default::default() };
    let result = super::save(dir.path(), &secrets, ID, &format!(" \n{}\t ", token()), |_| next);
    if expected == OwnerCheckStatus::Mismatch {
        assert_eq!(result.unwrap_err(), ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    } else {
        assert_eq!(result.unwrap().owner_check, expected);
    }
    let after = status_all(dir.path()).unwrap().remove(0);
    assert_eq!(after.owner_check, expected);
    assert_eq!(after.registered_at, before.registered_at);
    assert_eq!(after.expires_at, before.expires_at);
    assert_eq!(after.fingerprint, before.fingerprint);
    assert_ne!(after.owner_checked_at, before.owner_checked_at);
    assert_eq!(secrets.reads.get(), 1);
    let restores_secret = missing_secret && expected != OwnerCheckStatus::Mismatch;
    assert_eq!(secrets.writes.get(), usize::from(restores_secret));
    assert_eq!(secrets.deletes.get(), 0);
    let stored = secrets.memory.read(ID).unwrap();
    assert!(if missing_secret && !restores_secret { stored.is_none() } else { stored.as_deref() == Some(token().as_str()) });
    if expected == OwnerCheckStatus::Mismatch {
        assert_eq!(after.owner_method, before.owner_method);
        assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).err().unwrap(), ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    } else {
        assert!(load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().is_some());
    }
}

macro_rules! p1001_case {
    ($name:ident, $method:expr, $next:expr, $shared:expr, $expected:ident, $missing:expr) => {
        #[test]
        fn $name() { assert_p1001_same_token($method, $next, $shared, OwnerCheckStatus::$expected, $missing); }
    };
}
p1001_case!(p1001_same_profile_mismatch_survives_403, Some("profile"), rv01_unavailable(OwnerCheck::Rejected { status: 403 }), false, Mismatch, false);
p1001_case!(p1001_same_profile_mismatch_survives_429, Some("profile"), rv01_unavailable(OwnerCheck::RateLimited { retry_after_secs: Some(60) }), false, Mismatch, false);
p1001_case!(p1001_same_profile_mismatch_survives_unavailable, Some("profile"), rv01_unavailable(OwnerCheck::Unavailable), false, Mismatch, false);
p1001_case!(p1001_same_profile_mismatch_survives_matched_org, Some("profile"), org_check("org-1"), false, Mismatch, false);
p1001_case!(p1001_same_profile_mismatch_survives_shared_org, Some("profile"), org_check("org-1"), true, Mismatch, false);
p1001_case!(p1001_same_profile_mismatch_clears_with_verified, Some("profile"), owner("owner-1").into(), false, Verified, false);
p1001_case!(p1001_same_org_mismatch_clears_with_matched_org, Some("org"), org_check("org-1"), false, OrgMatched, false);
p1001_case!(p1001_same_org_mismatch_clears_with_verified, Some("org"), owner("owner-1").into(), false, Verified, false);
p1001_case!(p1001_same_org_mismatch_survives_unavailable, Some("org"), rv01_unavailable(OwnerCheck::Unavailable), false, Mismatch, false);
p1001_case!(p1001_same_org_mismatch_survives_shared_org, Some("org"), org_check("org-1"), true, Mismatch, false);
p1001_case!(p1001_same_legacy_mismatch_clears_with_matched_org, None, org_check("org-1"), false, OrgMatched, false);
p1001_case!(p1001_same_legacy_mismatch_survives_unavailable, None, rv01_unavailable(OwnerCheck::Unavailable), false, Mismatch, false);
p1001_case!(p1001_same_legacy_mismatch_survives_shared_org, None, org_check("org-1"), true, Mismatch, false);
p1001_case!(p1001_missing_secret_retains_profile_mismatch_by_fingerprint, Some("profile"), org_check("org-1"), false, Mismatch, true);

#[test]
fn p1001_same_token_preserves_strongest_mismatch_in_both_directions() {
    for first_profile in [true, false] {
        let (dir, secrets) = fixture();
        organization(dir.path(), ID, Some("org-1"));
        let before = save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
        recheck(dir.path(), &secrets, ID, |_| {
            if first_profile { owner("other-owner").into() } else { org_check("other-org") }
        }).unwrap();
        let error = super::save(dir.path(), &secrets, ID, &token(), |_| {
            if first_profile { org_check("other-org") } else { owner("other-owner").into() }
        }).unwrap_err();
        assert_eq!(error, ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
        let record = status_all(dir.path()).unwrap().remove(0);
        assert_eq!(record.owner_check, OwnerCheckStatus::Mismatch);
        assert_eq!(record.owner_method.as_deref(), Some("profile"));
        assert_eq!(record.registered_at, before.registered_at);
        assert_eq!(record.expires_at, before.expires_at);
        assert_eq!(record.fingerprint, before.fingerprint);
    }
}

#[test]
fn p1001_secret_read_failure_changes_nothing_and_returns_fixed_save_error() {
    let (dir, memory) = fixture();
    save(dir.path(), &memory, ID, &token(), |_| owner("owner-1")).unwrap();
    let before = fs::read(dir.path().join(FILE)).unwrap();
    let secrets = ObservedSecrets { memory, fail_read: true, ..Default::default() };
    let replacement = format!("sk-ant-oat02-{}", "b".repeat(32));
    let lookups = std::cell::Cell::new(0);
    let error = save(dir.path(), &secrets, ID, &replacement, |_| {
        lookups.set(lookups.get() + 1);
        OwnerCheck::Unavailable
    }).unwrap_err();
    assert_eq!(error, ERR_REGISTRY_SAVE_FAILED);
    assert_eq!(lookups.get(), 0);
    assert!(!error.contains("sk-ant-"));
    assert_eq!(secrets.reads.get(), 1);
    assert_eq!(secrets.writes.get(), 0);
    assert_eq!(secrets.deletes.get(), 0);
    assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), before);
    assert!(secrets.memory.read(ID).unwrap().as_deref() == Some(token().as_str()));
}

#[test]
fn p1001_record_fingerprint_starts_new_registration_when_existing_secret_matches_input() {
    let (dir, memory) = fixture();
    organization(dir.path(), ID, Some("org-1"));
    let mut before = save(dir.path(), &memory, ID, &token(), |_| owner("owner-1")).unwrap();
    before.owner_check = OwnerCheckStatus::Mismatch;
    before.owner_method = Some("profile".into());
    before.fingerprint = "0000000000".into();
    before.registered_at = "2026-01-01T00:00:00Z".into();
    save_status(dir.path(), &[before.clone()]).unwrap();
    let secrets = ObservedSecrets { memory, ..Default::default() };
    let record = super::save(dir.path(), &secrets, ID, &token(), |_| org_check("org-1")).unwrap();
    assert_eq!(record.owner_check, OwnerCheckStatus::OrgMatched);
    assert_eq!(record.owner_method.as_deref(), Some("org"));
    assert_eq!(record.fingerprint, token_fingerprint(&token()));
    assert_ne!(record.registered_at, before.registered_at);
    assert_eq!(secrets.reads.get(), 1);
    assert_eq!(secrets.writes.get(), 0);
    assert_eq!(secrets.deletes.get(), 0);
    let loaded = load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().unwrap();
    assert!(loaded.token == token(), "reregistered secret must launch");
    assert_eq!(loaded.status, record);
}

const P1002_RECORD_MISMATCH: &str = "cli_account.error.launch_token_record_mismatch";

fn p1002_replacement() -> String { format!("sk-ant-oat02-{}", "b".repeat(32)) }
fn p1002_status_failure(_: &Path, _: &[LaunchTokenStatus]) -> Result<(), String> {
    Err(ERR_REGISTRY_SAVE_FAILED.into())
}
fn assert_p1002_fixed_error(error: &str, expected: &str) {
    assert_eq!(error, expected);
    assert!(error.starts_with("cli_account.error."));
    assert!(!error.contains("sk-ant-"));
    assert!(!error.contains(&token()));
    assert!(!error.contains(&p1002_replacement()));
}

#[test]
fn p1002_status_save_failure_restores_previous_secret_and_record() {
    let (dir, memory) = fixture();
    let before = save(dir.path(), &memory, ID, &token(), |_| owner("owner-1")).unwrap();
    let bytes = fs::read(dir.path().join(FILE)).unwrap();
    let secrets = ObservedSecrets { memory, ..Default::default() };
    let saw_new_secret = std::cell::Cell::new(false);
    let error = super::save_with_status_writer(dir.path(), &secrets, ID, &p1002_replacement(),
        |_| OwnerCheck::Unavailable.into(), |_, _| {
            saw_new_secret.set(secrets.memory.read(ID).unwrap().as_deref() == Some(p1002_replacement().as_str()));
            Err(ERR_REGISTRY_SAVE_FAILED.into())
        }).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_REGISTRY_SAVE_FAILED);
    assert!(saw_new_secret.get());
    assert!(secrets.memory.read(ID).unwrap().as_deref() == Some(token().as_str()), "previous secret must be restored");
    assert_eq!(secrets.reads.get(), 1);
    assert_eq!(secrets.writes.get(), 2);
    assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), bytes);
    let loaded = load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().unwrap();
    assert!(loaded.token == token(), "launch must use the previous secret");
    assert_eq!(loaded.status, before);
}

#[test]
fn p1002_first_status_save_failure_removes_the_new_secret() {
    let (dir, secrets) = fixture();
    let error = super::save_with_status_writer(dir.path(), &secrets, ID, &token(),
        |_| owner("owner-1").into(), p1002_status_failure).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_REGISTRY_SAVE_FAILED);
    assert!(secrets.read(ID).unwrap().is_none(), "failed first registration must leave no secret");
    assert!(status_all(dir.path()).unwrap().is_empty());
    assert!(load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().is_none());
}

struct RollbackFailingSecrets {
    memory: MemorySecrets,
    writes: std::cell::Cell<usize>,
}
impl LaunchTokenStore for RollbackFailingSecrets {
    fn read(&self, id: &str) -> Result<Option<String>, String> { self.memory.read(id) }
    fn write(&self, id: &str, value: &str) -> Result<(), String> {
        self.writes.set(self.writes.get() + 1);
        if self.writes.get() > 1 { Err(token()) } else { self.memory.write(id, value) }
    }
    fn delete(&self, _: &str) -> Result<(), String> { Err(token()) }
}

#[test]
fn p1002_failed_rollback_preserves_original_error_and_blocks_launch() {
    let (dir, memory) = fixture();
    let before = save(dir.path(), &memory, ID, &token(), |_| owner("owner-1")).unwrap();
    let secrets = RollbackFailingSecrets { memory, writes: std::cell::Cell::new(0) };
    let error = super::save_with_status_writer(dir.path(), &secrets, ID, &p1002_replacement(),
        |_| OwnerCheck::Unavailable.into(), p1002_status_failure).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_REGISTRY_SAVE_FAILED);
    assert_eq!(status_all(dir.path()).unwrap(), vec![before]);
    let launch_error = load_for_launch_with_store(dir.path(), &secrets, ID).err();
    assert_eq!(launch_error.as_deref(), Some(P1002_RECORD_MISMATCH));
    assert_p1002_fixed_error(launch_error.as_deref().unwrap(), P1002_RECORD_MISMATCH);
    assert_eq!(secrets.writes.get(), 2);
}

#[test]
fn p1002_launch_rejects_a_secret_with_a_different_record_fingerprint() {
    let (dir, secrets) = fixture();
    save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    secrets.write(ID, &p1002_replacement()).unwrap();
    let error = load_for_launch_with_store(dir.path(), &secrets, ID).err();
    assert_eq!(error.as_deref(), Some(P1002_RECORD_MISMATCH));
    assert_p1002_fixed_error(error.as_deref().unwrap(), P1002_RECORD_MISMATCH);
}

#[test]
fn p1002_recheck_rejects_a_different_fingerprint_without_lookup_or_record_changes() {
    let (dir, secrets) = fixture();
    save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    let before = fs::read(dir.path().join(FILE)).unwrap();
    secrets.write(ID, &p1002_replacement()).unwrap();
    let lookups = std::cell::Cell::new(0);
    let error = recheck(dir.path(), &secrets, ID, |_| {
        lookups.set(lookups.get() + 1);
        owner("owner-1").into()
    }).err();
    assert_eq!(error.as_deref(), Some(P1002_RECORD_MISMATCH));
    assert_p1002_fixed_error(error.as_deref().unwrap(), P1002_RECORD_MISMATCH);
    assert_eq!(lookups.get(), 0);
    assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), before);
}

#[test]
fn p1002_matching_fingerprints_allow_launch_and_recheck() {
    assert_eq!(ERR_LAUNCH_TOKEN_RECORD_MISMATCH, P1002_RECORD_MISMATCH);
    let (dir, secrets) = fixture();
    let before = save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    let loaded = load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().unwrap();
    assert!(loaded.token == token(), "matching secret must launch");
    assert_eq!(loaded.status, before);
    let lookups = std::cell::Cell::new(0);
    let result = recheck(dir.path(), &secrets, ID, |_| {
        lookups.set(lookups.get() + 1);
        owner("owner-1").into()
    }).unwrap();
    assert_eq!(lookups.get(), 1);
    assert_eq!(result.owner_check, OwnerCheckStatus::Verified);
    for text in [serde_json::to_string(&result).unwrap(), format!("{result:?}"), fs::read_to_string(dir.path().join(FILE)).unwrap()] {
        assert!(!text.contains("sk-ant-"));
    }
}

p1001_case!(p1001_answer1_missing_profile_secret_recovers_with_verified, Some("profile"), owner("owner-1").into(), false, Verified, true);
p1001_case!(p1001_answer1_missing_org_secret_recovers_with_org_match, Some("org"), org_check("org-1"), false, OrgMatched, true);
p1001_case!(p1001_answer1_missing_profile_secret_stays_blocked_when_unavailable, Some("profile"), rv01_unavailable(OwnerCheck::Unavailable), false, Mismatch, true);

fn p1001_answer1_missing_profile_secret() -> (tempfile::TempDir, MemorySecrets) {
    let (dir, secrets) = fixture();
    save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1")).unwrap();
    recheck(dir.path(), &secrets, ID, |_| owner("other-owner").into()).unwrap();
    secrets.delete(ID).unwrap();
    (dir, secrets)
}

#[test]
fn p1001_answer1_missing_secret_status_failure_rolls_back_recovered_secret() {
    let (dir, memory) = p1001_answer1_missing_profile_secret();
    let before = fs::read(dir.path().join(FILE)).unwrap();
    let secrets = ObservedSecrets { memory, ..Default::default() };
    let saw_recovered_secret = std::cell::Cell::new(false);
    let error = super::save_with_status_writer(dir.path(), &secrets, ID, &token(),
        |_| owner("owner-1").into(), |_, _| {
            saw_recovered_secret.set(secrets.memory.read(ID).unwrap().as_deref() == Some(token().as_str()));
            Err(ERR_REGISTRY_SAVE_FAILED.into())
        }).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_REGISTRY_SAVE_FAILED);
    assert!(saw_recovered_secret.get(), "secret must be written before saving the recovered record");
    assert_eq!(secrets.reads.get(), 1);
    assert_eq!(secrets.writes.get(), 1);
    assert_eq!(secrets.deletes.get(), 1);
    assert!(secrets.memory.read(ID).unwrap().is_none(), "failed recovery must restore the empty store");
    assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), before);
}

#[test]
fn p1001_answer1_missing_secret_write_failure_keeps_the_record_unchanged() {
    let (dir, memory) = p1001_answer1_missing_profile_secret();
    let before = fs::read(dir.path().join(FILE)).unwrap();
    let secrets = ObservedSecrets { memory, fail_write: true, ..Default::default() };
    let persisted = std::cell::Cell::new(false);
    let error = super::save_with_status_writer(dir.path(), &secrets, ID, &token(),
        |_| owner("owner-1").into(), |base, records| {
            persisted.set(true);
            save_status(base, records)
        }).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_REGISTRY_SAVE_FAILED);
    assert!(!persisted.get());
    assert_eq!(secrets.reads.get(), 1);
    assert_eq!(secrets.writes.get(), 1);
    assert_eq!(secrets.deletes.get(), 0);
    assert!(secrets.memory.read(ID).unwrap().is_none());
    assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), before);
}

fn p1001_answer1_failed_rollback() -> (tempfile::TempDir, MemorySecrets, LaunchTokenStatus) {
    let (dir, memory) = fixture();
    organization(dir.path(), ID, Some("org-1"));
    let mut before = save(dir.path(), &memory, ID, &token(), |_| owner("owner-1")).unwrap();
    before.registered_at = "2026-01-01T00:00:00Z".into();
    before.expires_at = "2027-01-01T00:00:00Z".into();
    save_status(dir.path(), &[before.clone()]).unwrap();
    let secrets = RollbackFailingSecrets { memory, writes: std::cell::Cell::new(0) };
    let error = super::save_with_status_writer(dir.path(), &secrets, ID, &p1002_replacement(),
        |_| OwnerCheck::Unavailable.into(), p1002_status_failure).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_REGISTRY_SAVE_FAILED);
    assert_eq!(secrets.writes.get(), 2);
    assert_eq!(status_all(dir.path()).unwrap(), vec![before.clone()]);
    assert!(secrets.memory.read(ID).unwrap().as_deref() == Some(p1002_replacement().as_str()));
    assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).err().as_deref(), Some(ERR_LAUNCH_TOKEN_RECORD_MISMATCH));
    (dir, secrets.memory, before)
}

#[test]
fn p1001_answer1_new_secret_reregistration_recovers_from_failed_rollback() {
    let (dir, memory, before) = p1001_answer1_failed_rollback();
    let secrets = ObservedSecrets { memory, ..Default::default() };
    let record = super::save(dir.path(), &secrets, ID, &p1002_replacement(), |_| owner("owner-1").into()).unwrap();
    assert_eq!(record.owner_check, OwnerCheckStatus::Verified);
    assert_eq!(record.fingerprint, token_fingerprint(&p1002_replacement()));
    assert_ne!(record.registered_at, before.registered_at);
    assert_eq!(secrets.reads.get(), 1);
    assert_eq!(secrets.writes.get(), 0);
    let loaded = load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().unwrap();
    assert!(loaded.token == p1002_replacement(), "reregistered new secret must launch");
    assert_eq!(loaded.status, record);
}

#[test]
fn p1001_answer1_previous_secret_reregistration_recovers_without_extending_registration() {
    let (dir, memory, before) = p1001_answer1_failed_rollback();
    let secrets = ObservedSecrets { memory, ..Default::default() };
    let record = super::save(dir.path(), &secrets, ID, &token(), |_| owner("owner-1").into()).unwrap();
    assert_eq!(record.owner_check, OwnerCheckStatus::Verified);
    assert_eq!(record.registered_at, before.registered_at);
    assert_eq!(record.expires_at, before.expires_at);
    assert_eq!(record.fingerprint, before.fingerprint);
    assert_eq!(secrets.reads.get(), 1);
    assert_eq!(secrets.writes.get(), 1);
    let loaded = load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().unwrap();
    assert!(loaded.token == token(), "reregistered previous secret must launch");
    assert_eq!(loaded.status, record);
}

#[test]
fn p1001_answer1_previous_profile_mismatch_cannot_replace_the_secret_with_an_org_match() {
    let (dir, memory, mut before) = p1001_answer1_failed_rollback();
    before.owner_check = OwnerCheckStatus::Mismatch;
    before.owner_method = Some("profile".into());
    save_status(dir.path(), &[before.clone()]).unwrap();
    let secrets = ObservedSecrets { memory, ..Default::default() };
    let error = super::save(dir.path(), &secrets, ID, &token(), |_| org_check("org-1")).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    assert_eq!(secrets.reads.get(), 1);
    assert_eq!(secrets.writes.get(), 0);
    assert_eq!(secrets.deletes.get(), 0);
    let record = status_all(dir.path()).unwrap().remove(0);
    assert_eq!(record.owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(record.owner_method.as_deref(), Some("profile"));
    assert_eq!(record.registered_at, before.registered_at);
    assert_eq!(record.expires_at, before.expires_at);
    assert_eq!(record.fingerprint, before.fingerprint);
    assert!(secrets.memory.read(ID).unwrap().as_deref() == Some(p1002_replacement().as_str()));
    assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).err().as_deref(), Some(ERR_LAUNCH_TOKEN_RECORD_MISMATCH));
}

fn rc01_registered_token(org_matched: bool) -> (tempfile::TempDir, ObservedSecrets, LaunchTokenStatus) {
    let (dir, memory) = fixture();
    organization(dir.path(), ID, Some("org-1"));
    let mut before = super::save(dir.path(), &memory, ID, &token(), |_| {
        if org_matched { org_check("org-1") } else { owner("owner-1").into() }
    }).unwrap();
    before.registered_at = "2026-01-01T00:00:00Z".into();
    before.expires_at = "2027-01-01T00:00:00Z".into();
    before.owner_checked_at = Some("2026-01-01T00:00:00Z".into());
    save_status(dir.path(), &[before.clone()]).unwrap();
    (dir, ObservedSecrets { memory, ..Default::default() }, before)
}

fn assert_rc01_same_token_records_mismatch(org_matched: bool) {
    let (dir, secrets, before) = rc01_registered_token(org_matched);
    let evidence = super::super::tab_evidence::TabAccountEvidence::claude(&before);
    super::super::tab_evidence::remember(dir.path(), "rc01-pty", evidence, |_| true);
    let outcome = super::save_with_outcome(dir.path(), &secrets, ID, &token(),
        |_| owner("other-owner").into()).unwrap();
    let SaveOutcome::MismatchRecorded(after) = outcome else {
        panic!("a persisted mismatch must be reported separately from a saved registration");
    };
    assert_eq!(after.owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(after.owner_method.as_deref(), Some("profile"));
    assert_eq!(after.registered_at, before.registered_at);
    assert_eq!(after.expires_at, before.expires_at);
    assert_eq!(after.fingerprint, before.fingerprint);
    assert_ne!(after.owner_checked_at, before.owner_checked_at);
    assert_eq!(status_all(dir.path()).unwrap(), vec![after]);
    assert_eq!(secrets.reads.get(), 1);
    assert_eq!(secrets.writes.get(), 0);
    assert_eq!(secrets.deletes.get(), 0);
    assert!(secrets.memory.read(ID).unwrap().as_deref() == Some(token().as_str()));
    let current = super::super::tab_evidence::get(dir.path(), "rc01-pty", |_| true).unwrap().unwrap();
    assert_eq!(current.result, super::super::tab_evidence::EvidenceResult::Mismatch);
    let error = load_for_launch_with_store(dir.path(), &secrets, ID).err().unwrap();
    assert_p1002_fixed_error(&error, ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    assert!(!fs::read_to_string(dir.path().join(FILE)).unwrap().contains("sk-ant-"));
}

#[test]
fn rc01_same_verified_token_returns_mismatch_recorded_and_blocks_launch() {
    assert_rc01_same_token_records_mismatch(false);
}

#[test]
fn rc01_same_org_matched_token_returns_mismatch_recorded_and_blocks_launch() {
    assert_rc01_same_token_records_mismatch(true);
}

#[test]
fn rc01_same_token_status_failure_returns_error_and_preserves_verified_record() {
    let (dir, secrets, before) = rc01_registered_token(false);
    let bytes = fs::read(dir.path().join(FILE)).unwrap();
    let attempted = std::cell::Cell::new(false);
    let error = super::save_with_status_writer(dir.path(), &secrets, ID, &token(),
        |_| owner("other-owner").into(), |base, records| {
            attempted.set(true);
            assert_eq!(records[0].owner_check, OwnerCheckStatus::Mismatch);
            p1002_status_failure(base, records)
        }).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_REGISTRY_SAVE_FAILED);
    assert!(attempted.get());
    assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), bytes);
    assert_eq!(status_all(dir.path()).unwrap(), vec![before.clone()]);
    assert_eq!(secrets.writes.get(), 0);
    assert_eq!(secrets.deletes.get(), 0);
    assert!(secrets.memory.read(ID).unwrap().as_deref() == Some(token().as_str()));
    assert_eq!(load_for_launch_with_store(dir.path(), &secrets, ID).unwrap().unwrap().status, before);
}

#[test]
fn rc01_new_mismatched_token_returns_error_without_changing_record_or_secret() {
    let (dir, secrets, before) = rc01_registered_token(false);
    let bytes = fs::read(dir.path().join(FILE)).unwrap();
    let error = super::save_with_outcome(dir.path(), &secrets, ID, &p1002_replacement(),
        |_| owner("other-owner").into()).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), bytes);
    assert_eq!(status_all(dir.path()).unwrap(), vec![before]);
    assert_eq!(secrets.writes.get(), 0);
    assert_eq!(secrets.deletes.get(), 0);
    assert!(secrets.memory.read(ID).unwrap().as_deref() == Some(token().as_str()));
}

#[test]
fn rc01_non_mismatch_registrations_return_saved_after_persisting() {
    for same in [false, true] {
        for expected in [OwnerCheckStatus::Verified, OwnerCheckStatus::OrgMatched,
            OwnerCheckStatus::OrgShared, OwnerCheckStatus::Unverified] {
            let (dir, memory) = fixture();
            organization(dir.path(), ID, Some("org-1"));
            if expected == OwnerCheckStatus::OrgShared {
                let mut file = registry::load(dir.path()).unwrap();
                let mut other = file.profiles[0].clone();
                other.id = "claude-shared".into();
                other.identity_key = "owner-2".into();
                file.profiles.push(other);
                registry::save(dir.path(), &file).unwrap();
                organization(dir.path(), "claude-shared", Some("org-1"));
            }
            if same {
                save(dir.path(), &memory, ID, &token(), |_| owner("owner-1")).unwrap();
            }
            let secrets = ObservedSecrets { memory, ..Default::default() };
            let outcome = super::save_with_outcome(dir.path(), &secrets, ID, &token(), |_| {
                match expected {
                    OwnerCheckStatus::Verified => owner("owner-1").into(),
                    OwnerCheckStatus::OrgMatched | OwnerCheckStatus::OrgShared => org_check("org-1"),
                    _ => OwnerCheck::Unavailable.into(),
                }
            }).unwrap();
            let SaveOutcome::Saved(after) = outcome else {
                panic!("a persisted non-mismatch registration must return Saved");
            };
            assert_eq!(after.owner_check, expected);
            assert_eq!(status_all(dir.path()).unwrap(), vec![after]);
            assert_eq!(secrets.reads.get(), 1);
            assert_eq!(secrets.writes.get(), usize::from(!same));
            assert_eq!(secrets.deletes.get(), 0);
            assert!(secrets.memory.read(ID).unwrap().as_deref() == Some(token().as_str()));
        }
    }
}

#[test]
fn rc01_legacy_save_returns_owner_error_after_recording_same_token_mismatch() {
    let (dir, secrets, before) = rc01_registered_token(false);
    let error = super::save(dir.path(), &secrets, ID, &token(),
        |_| owner("other-owner").into()).unwrap_err();
    assert_p1002_fixed_error(&error, ERR_LAUNCH_TOKEN_OWNER_MISMATCH);
    let after = status_all(dir.path()).unwrap().remove(0);
    assert_eq!(after.owner_check, OwnerCheckStatus::Mismatch);
    assert_eq!(after.registered_at, before.registered_at);
    assert_eq!(after.expires_at, before.expires_at);
    assert_eq!(after.fingerprint, before.fingerprint);
    assert_eq!(secrets.writes.get(), 0);
}
