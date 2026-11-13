use super::*;

#[test]
fn v2_launch_and_recheck_return_only_the_confirmed_owner_email() {
    use base64::Engine;
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let f = Fixture::new(provider); f.ready();
        if provider == CliProvider::Codex {
            let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                br#"{"email":"fixture@example.test","https://api.openai.com/auth":{"chatgpt_account_id":"owner-fixture"}}"#);
            let text = serde_json::json!({"tokens":{"access_token":"synthetic-access","id_token":format!("header.{claims}.signature")}});
            fs::write(f.home().join("auth.json"), text.to_string()).unwrap();
        }
        let context = f.launch("confirmed-email", |_| false).unwrap();
        assert_eq!(context.owner_email.as_deref(), Some("fixture@example.test"));
        assert!(context.owner_checked_at.is_some());
        assert_eq!(recheck_owner(f.base.path(), provider, &f.id).unwrap().as_deref(), Some("fixture@example.test"));
        f.auth("different-owner");
        assert_eq!(recheck_owner(f.base.path(), provider, &f.id).unwrap_err(), ERR_HOME_OWNER_MISMATCH);
    }
}

#[cfg(unix)]
#[test]
fn v2_recheck_is_shallow_and_never_scans_history_or_mutates_the_manifest() {
    use std::os::unix::fs::symlink;
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let f = Fixture::new(provider); f.ready();
        let manifest = fs::read(f.base.path().join("cli_account_homes/manifest.json")).unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir_all(f.home().join("sessions/deep")).unwrap();
        symlink(outside.path(), f.home().join("sessions/deep/not-private")).unwrap();
        assert!(recheck_owner(f.base.path(), provider, &f.id).is_ok());
        assert_eq!(f.launch("deep-check-required", |_| false).unwrap_err(), ERR_HOME_PATH_INVALID);
        assert_eq!(fs::read(f.base.path().join("cli_account_homes/manifest.json")).unwrap(), manifest);
    }
}

use tempfile::{tempdir, TempDir};
use super::super::{CliAccountProfile, registry::CliAccountsFile};

struct Fixture { base: TempDir, source: TempDir, provider: CliProvider, id: String }
impl Fixture {
    fn new(provider: CliProvider) -> Self {
        let base = tempdir().unwrap(); let source = tempdir().unwrap();
        let id = format!("{}-fixture", provider_name(provider).unwrap());
        let profile = CliAccountProfile { id: id.clone(), provider, label: "fixture".into(), email: None,
            identity_key: "owner-fixture".into(), plan: None, org_name: None, captured_at: now(), last_switched_at: None,
            needs_relogin: false, refresh_rejected_at: None, foreign_token_owner: None };
        registry::save(base.path(), &CliAccountsFile { profiles: vec![profile], ..Default::default() }).unwrap();
        Self { base, source, provider, id }
    }
    fn home(&self) -> PathBuf { self.base.path().join("cli_account_homes").join(provider_name(self.provider).unwrap()).join(&self.id) }
    fn begin(&self) -> HomeLoginStatus { begin_login(self.base.path(), self.provider, &self.id, |_| false, self.source.path()).unwrap() }
    fn auth(&self, owner: &str) {
        let text = match self.provider {
            CliProvider::Codex => serde_json::json!({"tokens":{"account_id":owner,"access_token":"fixture-expired-access","refresh_token":"fixture-refresh"}}),
            _ => serde_json::json!({"https://fixture.invalid":{"user_id":owner,"email":"fixture@example.test","key":"header.eyJ0aWVyIjoiZml4dHVyZSJ9.signature","refresh_token":"fixture-refresh"}}),
        };
        fs::write(self.home().join("auth.json"), serde_json::to_vec(&text).unwrap()).unwrap();
    }
    fn ready(&self) -> HomeLoginStatus {
        let login = self.begin();
        claim_login(self.base.path(), &login.login_id, "fixture-login").unwrap();
        finish_login_launch(&login.login_id, true);
        self.auth("owner-fixture");
        assert_eq!(poll_login(self.base.path(), &login.login_id, |_| false).unwrap().state, "pending");
        poll_login(self.base.path(), &login.login_id, |_| false).unwrap()
    }
    fn launch(&self, session: &str, alive: impl Fn(&str) -> bool) -> Result<AccountLaunchContext, String> {
        prepare_launch(self.base.path(), self.provider, &self.id, session, alive, self.source.path())
    }
}

#[test]
fn account_homes_login_commands_point_only_to_private_homes() {
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let f = Fixture::new(provider);
        let login = f.begin();
        let (command, args, env_key, home) = claim_login(f.base.path(), &login.login_id, "login").unwrap();
        assert_eq!(command, provider_name(provider).unwrap());
        assert_eq!(home, f.home().canonicalize().unwrap());
        assert_eq!(env_key, if provider == CliProvider::Codex { "CODEX_HOME" } else { "GROK_HOME" });
        assert_eq!(args, staging::login_command(provider).1);
        assert!(!f.base.path().join("cli_account_snapshots").exists());
        assert!(!f.base.path().join("cli_login_staging").exists());
        assert!(!f.source.path().join("auth.json").exists());
    }
}

#[test]
fn account_homes_manifest_and_debug_have_only_nonsecret_state() {
    let f = Fixture::new(CliProvider::Codex);
    assert_eq!(f.ready().home.state, HomeState::Ready);
    let context = f.launch("tab", |_| false).unwrap();
    let stored = fs::read_to_string(f.base.path().join("cli_account_homes/manifest.json")).unwrap();
    let wire = serde_json::to_string(&list(f.base.path()).unwrap()).unwrap();
    for text in [stored, wire, format!("{context:?}")] {
        for excluded in ["auth.json", "fixture-expired-access", "fixture-refresh", "access_token", "refresh_token", f.home().to_str().unwrap(), f.source.path().to_str().unwrap()] { assert!(!text.contains(excluded), "excluded data leaked"); }
    }
    assert_eq!(context.session_roots(), vec![f.home().canonicalize().unwrap().join("sessions"), f.home().canonicalize().unwrap().join("archived_sessions")]);
}

#[test]
fn account_homes_invalid_ids_and_provider_mismatch_are_rejected_before_creation() {
    let f = Fixture::new(CliProvider::Codex);
    for id in ["..", "codex-../escape", "codex-a\\..\\sibling", "/codex-out", "codex-a/../b", "", "codex-a:evil"] {
        assert_eq!(begin_login(f.base.path(), f.provider, id, |_| false, f.source.path()).unwrap_err(), ERR_HOME_PATH_INVALID);
    }
    assert_eq!(begin_login(f.base.path(), CliProvider::Grok, &f.id, |_| false, f.source.path()).unwrap_err(), ERR_LAUNCH_ACCOUNT_NOT_FOUND);
    assert!(!f.base.path().join("cli_account_homes").exists());
}

#[cfg(unix)]
#[test]
fn account_homes_reject_symlink_root_sibling_provider_home_and_auth() {
    use std::os::unix::fs::symlink;
    for level in ["root", "provider", "home", "auth"] {
        let f = Fixture::new(CliProvider::Codex);
        let outside = tempdir().unwrap();
        match level {
            "root" => symlink(outside.path(), f.base.path().join("cli_account_homes")).unwrap(),
            "provider" => { fs::create_dir(f.base.path().join("cli_account_homes")).unwrap(); symlink(outside.path(), f.base.path().join("cli_account_homes/codex")).unwrap(); }
            "home" => { fs::create_dir_all(f.home().parent().unwrap()).unwrap(); symlink(outside.path(), f.home()).unwrap(); }
            _ => { f.ready(); fs::rename(f.home().join("auth.json"), outside.path().join("auth.json")).unwrap(); symlink(outside.path().join("auth.json"), f.home().join("auth.json")).unwrap(); }
        }
        assert!(matches!(begin_login(f.base.path(), f.provider, &f.id, |_| false, f.source.path()).as_ref().err().map(String::as_str), Some(ERR_HOME_PATH_INVALID)));
    }
    let f = Fixture::new(CliProvider::Codex);
    let sibling = f.base.path().join("cli_account_homes-sibling"); fs::create_dir(&sibling).unwrap();
    symlink(&sibling, f.base.path().join("cli_account_homes")).unwrap();
    assert_eq!(f.launch("tab", |_| false).unwrap_err(), ERR_HOME_PATH_INVALID);
}

#[cfg(unix)]
#[test]
fn account_homes_auth_hardlinks_are_not_an_isolated_home() {
    let f = Fixture::new(CliProvider::Codex); f.ready();
    let outside = tempdir().unwrap(); fs::hard_link(f.home().join("auth.json"), outside.path().join("copy")).unwrap();
    assert_eq!(f.launch("tab", |_| false).unwrap_err(), ERR_HOME_PATH_INVALID);
}

#[test]
fn account_homes_profile_bases_do_not_cross_and_never_use_staging() {
    let f = Fixture::new(CliProvider::Grok); f.ready();
    let profile_base = f.base.path().join("profiles/seat2a"); fs::create_dir_all(&profile_base).unwrap();
    let registered = registry::load(f.base.path()).unwrap(); registry::save(&profile_base, &registered).unwrap();
    let login = begin_login(&profile_base, f.provider, &f.id, |_| false, f.source.path()).unwrap();
    let (_, _, _, home) = claim_login(&profile_base, &login.login_id, "separate").unwrap();
    assert!(home.starts_with(profile_base.canonicalize().unwrap()));
    assert_ne!(home, f.home());
    assert_eq!(list(f.base.path()).unwrap()[0].state, HomeState::Ready);
}

#[test]
fn account_homes_state_transitions_ignore_expiry_and_retain_generation() {
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let f = Fixture::new(provider);
        let ready = f.ready(); assert_eq!(ready.home.generation, 1);
        assert_eq!(ready.home.owner, "matched");
        assert_eq!(f.launch("tab", |_| false).unwrap().generation, 1);
        // exp=1 is an expired access JWT. The CLI remains its refresh authority.
        let mut expired:serde_json::Value=serde_json::from_slice(&fs::read(f.home().join("auth.json")).unwrap()).unwrap();
        if provider==CliProvider::Codex { expired["tokens"]["access_token"]="fixture.eyJleHAiOjF9.signature".into(); }
        else { expired["https://fixture.invalid"]["key"]="fixture.eyJleHAiOjF9.signature".into(); }
        fs::write(f.home().join("auth.json"),serde_json::to_vec(&expired).unwrap()).unwrap();
        assert_eq!(f.launch("expired-access",|_|false).unwrap().generation,1);
        assert_eq!(list(f.base.path()).unwrap()[0].state,HomeState::Ready);
        f.auth("other-owner");
        assert_eq!(f.launch("wrong", |_| false).unwrap_err(), ERR_HOME_OWNER_MISMATCH);
        assert_eq!(list(f.base.path()).unwrap()[0].state, HomeState::NeedsLogin);
        let relogin = f.begin(); assert_eq!(relogin.home.state, HomeState::AwaitingLogin);
        claim_login(f.base.path(), &relogin.login_id, "again").unwrap(); finish_login_launch(&relogin.login_id, true); f.auth("owner-fixture");
        poll_login(f.base.path(), &relogin.login_id, |_| true).unwrap();
        let ready = poll_login(f.base.path(), &relogin.login_id, |_| true).unwrap();
        assert_eq!(ready.home.state, HomeState::Ready); assert_eq!(ready.home.generation, 2);
    }
}

#[test]
fn account_homes_missing_or_corrupt_auth_enters_needs_login() {
    for contents in [None, Some("broken"), Some("{}") ] {
        let f = Fixture::new(CliProvider::Codex); f.ready();
        if let Some(text) = contents { fs::write(f.home().join("auth.json"), text).unwrap(); }
        else { fs::rename(f.home().join("auth.json"), f.home().join("retained-auth.fixture")).unwrap(); }
        assert!(f.launch("tab", |_| false).is_err());
        assert_eq!(list(f.base.path()).unwrap()[0].state, HomeState::NeedsLogin);
    }
}

#[test]
fn account_homes_cancel_timeout_mismatch_and_early_exit_never_become_ready() {
    for reason in ["cancel", "timeout", "mismatch", "exit", "spawn-failure"] {
        let f = Fixture::new(CliProvider::Grok); let login = f.begin();
        claim_login(f.base.path(), &login.login_id, "login").unwrap(); finish_login_launch(&login.login_id, true);
        match reason {
            "cancel" => { f.auth("owner-fixture"); cancel_login(f.base.path(), &login.login_id); }
            "timeout" => { runtime().logins.get_mut(&login.login_id).unwrap().started = Instant::now() - LOGIN_TIMEOUT; }
            "mismatch" => { f.auth("other-owner"); poll_login(f.base.path(), &login.login_id, |_| true).unwrap(); }
            "spawn-failure" => finish_login_launch(&login.login_id, false),
            _ => {}
        }
        let status = poll_login(f.base.path(), &login.login_id, |_| false).unwrap();
        assert_eq!(status.state, "failed", "{reason}"); assert!(status.reason.is_some());
        assert_eq!(list(f.base.path()).unwrap()[0].state, HomeState::AwaitingLogin);
        assert!(f.home().is_dir()); assert!(!f.base.path().join("cli_account_snapshots").exists());
    }
}

#[test]
fn account_homes_claim_and_begin_prevent_two_login_processes() {
    let f = Fixture::new(CliProvider::Codex); let login = f.begin();
    assert_eq!(begin_login(f.base.path(), f.provider, &f.id, |_| false, f.source.path()).unwrap_err(), super::super::ERR_LOGIN_ALREADY_RUNNING);
    claim_login(f.base.path(), &login.login_id, "first").unwrap();
    assert_eq!(claim_login(f.base.path(), &login.login_id, "second").unwrap_err(), super::super::ERR_LOGIN_ALREADY_RUNNING);
    assert!(f.launch("work", |_| false).is_err());
}

#[test]
fn account_homes_existing_auth_cannot_finish_a_new_login_without_a_cli_write() {
    let f = Fixture::new(CliProvider::Codex); f.ready();
    let login = f.begin(); claim_login(f.base.path(), &login.login_id, "relogin").unwrap(); finish_login_launch(&login.login_id, true);
    for _ in 0..3 { assert_eq!(poll_login(f.base.path(), &login.login_id, |_| true).unwrap().state, "pending"); }
    assert_eq!(poll_login(f.base.path(), &login.login_id, |_| false).unwrap().state, "failed");
}

#[test]
fn account_homes_active_tabs_share_home_and_block_login_and_unregister() {
    let f = Fixture::new(CliProvider::Codex); f.ready();
    let mut first = f.launch("one", |_| false).unwrap(); first.commit();
    let second = f.launch("two", |id| id == "one").unwrap();
    assert_eq!(first.home(), second.home());
    assert_eq!(begin_login(f.base.path(), f.provider, &f.id, |_| true, f.source.path()).unwrap_err(), ERR_HOME_IN_USE);
    assert_eq!(unregister(f.base.path(), f.provider, &f.id, |_| true).unwrap_err(), ERR_HOME_IN_USE);
    assert_eq!(context_for_session(f.base.path(), "one").unwrap().unwrap().home(), first.home());
    drop(second);
    unregister(f.base.path(), f.provider, &f.id, |_| false).unwrap();
    assert!(list(f.base.path()).unwrap().is_empty()); assert!(f.home().join("auth.json").exists());
}

#[test]
fn account_homes_failed_unregister_operation_keeps_the_manifest() {
    let f = Fixture::new(CliProvider::Grok); f.ready();
    let before = fs::read(f.base.path().join("cli_account_homes/manifest.json")).unwrap();
    assert_eq!(unregister_and(f.base.path(), f.provider, &f.id, |_| false, || Err("fixture-failure".into())).unwrap_err(), "fixture-failure");
    assert_eq!(before, fs::read(f.base.path().join("cli_account_homes/manifest.json")).unwrap());
}

#[test]
fn account_homes_settings_are_rebuilt_and_only_private_project_trust_survives() {
    let f = Fixture::new(CliProvider::Codex);
    fs::write(f.source.path().join("config.toml"), "model = 'source'\ncli_auth_credentials_store = 'keyring'\nsqlite_home = '/outside'\nlog_dir = '/outside'\n[projects.\"/same\"]\ntrust_level = 'untrusted'\n").unwrap();
    f.ready();
    fs::write(f.home().join("config.toml"), "model = 'private-change'\n[projects.\"/local\"]\ntrust_level = 'trusted'\n[projects.\"/local\".nested]\nvalue = [1, 2]\n[projects.\"/same\"]\ntrust_level = 'trusted'\n").unwrap();
    f.launch("tab", |_| false).unwrap();
    let text = fs::read_to_string(f.home().join("config.toml")).unwrap();
    let doc = toml_edit::Document::parse(text).unwrap();
    assert_eq!(doc["model"].as_str(), Some("source"));
    assert_eq!(doc["cli_auth_credentials_store"].as_str(), Some("file"));
    assert!(doc.get("sqlite_home").is_none()); assert!(doc.get("log_dir").is_none());
    assert_eq!(doc["projects"]["/local"]["trust_level"].as_str(), Some("trusted"));
    assert_eq!(doc["projects"]["/local"]["nested"]["value"].as_array().unwrap().len(), 2);
    assert_eq!(doc["projects"]["/same"]["trust_level"].as_str(), Some("untrusted"));
    fs::write(f.source.path().join("config.toml"), "model = 'changed'\n").unwrap();
    f.launch("next", |_| false).unwrap();
    assert!(fs::read_to_string(f.home().join("config.toml")).unwrap().contains("changed"));
    let manifest = read_manifest(f.base.path()).unwrap(); assert_eq!(manifest.homes[0].last_settings_digest.as_ref().unwrap().len(), 16);
}

#[test]
fn account_homes_settings_splicing_handles_comments_multiline_values_and_quoted_keys() {
    let source = "# fixture\n'cli_auth_credentials_store' = 'auto' # remove\nsqlite_home = \"\"\"\n/elsewhere\n\"\"\"\nlog_dir = '/elsewhere'\n[unrelated]\nvalue = ['keep', 'all']\n";
    let text = config_text(CliProvider::Codex, source, "").unwrap();
    let doc = toml_edit::Document::parse(&text).unwrap();
    assert_eq!(doc["unrelated"]["value"].as_array().unwrap().len(), 2);
    assert!(doc.get("sqlite_home").is_none()); assert!(doc.get("log_dir").is_none());
    assert_eq!(doc["cli_auth_credentials_store"].as_str(), Some("file"));
}

#[test]
fn account_homes_active_home_defers_settings_but_idle_invalid_source_blocks_launch() {
    let f = Fixture::new(CliProvider::Codex); f.ready();
    let before = fs::read(f.home().join("config.toml")).unwrap();
    let mut first = f.launch("one", |_| false).unwrap(); first.commit();
    fs::write(f.source.path().join("config.toml"), "invalid = [fixture-secret").unwrap();
    let second = f.launch("two", |id| id == "one").unwrap();
    assert_eq!(fs::read(f.home().join("config.toml")).unwrap(), before); drop(second);
    assert_eq!(f.launch("three", |_| false).unwrap_err(), ERR_HOME_ISOLATION_UNAVAILABLE);
    assert!(!runtime().sessions.contains_key(&(f.base.path().canonicalize().unwrap(), "three".into())));
}

#[test]
fn account_homes_only_allowed_assets_are_shared_and_grok_hooks_are_real_copies() {
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let f = Fixture::new(provider);
        for name in ["skills", "rules", "prompts", "hooks", "sessions", "archived_sessions", "secrets"] {
            fs::create_dir(f.source.path().join(name)).unwrap(); fs::write(f.source.path().join(name).join("fixture"), name).unwrap();
        }
        fs::write(f.source.path().join("AGENTS.md"), "fixture instructions").unwrap();
        fs::write(f.source.path().join("hooks.json"), "{}").unwrap();
        fs::write(f.source.path().join("hooks-paths"), "fixture hook path").unwrap();
        fs::write(f.source.path().join("auth.json"), "DO-NOT-READ-OR-COPY").unwrap();
        let before_source_auth = fs::read(f.source.path().join("auth.json")).unwrap();
        f.ready();
        assert_eq!(fs::read(f.source.path().join("auth.json")).unwrap(), before_source_auth);
        assert!(!f.home().join("sessions").exists()); assert!(!f.home().join("secrets").exists());
        if provider == CliProvider::Grok {
            assert!(!is_link(&fs::symlink_metadata(f.home().join("hooks")).unwrap()));
            assert_eq!(fs::read(f.home().join("hooks/fixture")).unwrap(), b"hooks");
            assert!(!f.home().join("rules").exists()); assert!(!f.home().join("prompts").exists());
        } else {
            for name in ["AGENTS.md", "hooks.json"] { assert!(!is_link(&fs::symlink_metadata(f.home().join(name)).unwrap())); }
        }
        assert!(f.home().join("skills/fixture").exists());
    }
}

#[cfg(unix)]
#[test]
fn account_homes_permissions_include_configuration_and_manifest() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(CliProvider::Codex); f.ready();
    for dir in [f.base.path().join("cli_account_homes"), f.home()] { assert_eq!(fs::metadata(dir).unwrap().permissions().mode() & 0o777, 0o700); }
    for file in [f.home().join("config.toml"), f.base.path().join("cli_account_homes/manifest.json")] { assert_eq!(fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600); }
}

#[test]
fn account_homes_env_is_local_to_each_launch_and_never_writes_process_env() {
    let process_env = || HOME_ENV_KEYS.iter().map(|key| ((*key).to_string(), std::env::var_os(key))).collect::<HashMap<_, _>>();
    let process_before = process_env();
    let first = Fixture::new(CliProvider::Codex); first.ready();
    let second = Fixture::new(CliProvider::Grok); second.ready();
    let mut env = HashMap::from([("OPENAI_API_KEY".into(), "fixture-key".into()), ("KEEP".into(), "kept".into())]);
    first.launch("codex-tab", |_| false).unwrap().apply_env(&mut env);
    assert_eq!(env.get("MYCMUX_ACCOUNT_HOME_KIND").map(String::as_str), Some("codex")); assert!(!env.contains_key("OPENAI_API_KEY"));
    let mut other = HashMap::new(); second.launch("grok-tab", |_| false).unwrap().apply_env(&mut other);
    assert!(!env.contains_key("GROK_HOME")); assert!(!other.contains_key("CODEX_HOME"));
    assert_eq!(process_env(), process_before);
}

#[test]
fn account_homes_created_state_survives_failed_settings_then_advances_to_awaiting() {
    let f=Fixture::new(CliProvider::Codex);
    fs::write(f.source.path().join("config.toml"), "fixture = [broken").unwrap();
    assert_eq!(begin_login(f.base.path(),f.provider,&f.id,|_|false,f.source.path()).unwrap_err(),ERR_HOME_ISOLATION_UNAVAILABLE);
    assert_eq!(list(f.base.path()).unwrap()[0].state,HomeState::Created);
    fs::write(f.source.path().join("config.toml"), "model='fixture'\n").unwrap();
    assert_eq!(f.begin().home.state,HomeState::AwaitingLogin);
}

#[test]
fn account_homes_inline_projects_merge_and_source_profiles_cannot_override_isolation() {
    let source="model='source'\nprojects={\"/same\"={trust_level='untrusted'}}\n";
    let local="model='local'\nprojects={\"/same\"={trust_level='trusted'},\"/local\"={trust_level='trusted'}}\n";
    let text=config_text(CliProvider::Codex,source,local).unwrap();
    let doc=toml_edit::Document::parse(text).unwrap();
    assert_eq!(doc["projects"]["/same"]["trust_level"].as_str(),Some("untrusted"));
    assert_eq!(doc["projects"]["/local"]["trust_level"].as_str(),Some("trusted"));
    for key in ["sqlite_home","log_dir","cli_auth_credentials_store"] {
        let source=format!("[profiles.fixture]\n{key}='/outside'\n");
        assert_eq!(config_text(CliProvider::Codex,&source,"").unwrap_err(),ERR_HOME_ISOLATION_UNAVAILABLE);
    }
}

#[test]
fn account_homes_auth_mutation_leaves_global_auth_registry_and_snapshot_bytes_untouched() {
    let f=Fixture::new(CliProvider::Codex); f.ready();
    fs::write(f.source.path().join("auth.json"),"global-auth-sentinel-do-not-read").unwrap();
    let snapshot_dir=f.base.path().join("cli_account_snapshots"); fs::create_dir(&snapshot_dir).unwrap();
    fs::write(snapshot_dir.join("snapshot.fixture"),"snapshot-sentinel-do-not-read").unwrap();
    let before=fs::read(f.base.path().join("cli_accounts.json")).unwrap();
    let auth=fs::read_to_string(f.home().join("auth.json")).unwrap().replace("fixture-expired-access","fixture-CLI-updated-access");
    fs::write(f.home().join("auth.json"),auth).unwrap();
    f.launch("tab",|_|false).unwrap();
    assert_eq!(fs::read(f.base.path().join("cli_accounts.json")).unwrap(),before);
    assert_eq!(fs::read_to_string(f.source.path().join("auth.json")).unwrap(),"global-auth-sentinel-do-not-read");
    assert_eq!(fs::read_to_string(snapshot_dir.join("snapshot.fixture")).unwrap(),"snapshot-sentinel-do-not-read");
    assert_eq!(fs::read_dir(snapshot_dir).unwrap().count(),1);
}

#[test]
fn account_homes_needs_login_and_failed_login_cannot_reauthenticate_until_tabs_exit() {
    let f=Fixture::new(CliProvider::Codex); f.ready();
    let mut first=f.launch("work-tab",|_|false).unwrap(); first.commit(); f.auth("different-owner");
    assert_eq!(f.launch("second",|id|id=="work-tab").unwrap_err(),ERR_HOME_OWNER_MISMATCH);
    assert_eq!(begin_login(f.base.path(),f.provider,&f.id,|id|id=="work-tab",f.source.path()).unwrap_err(),ERR_HOME_IN_USE);
    let login=f.begin(); claim_login(f.base.path(),&login.login_id,"login-tab").unwrap(); finish_login_launch(&login.login_id,true);
    f.auth("still-wrong-owner"); poll_login(f.base.path(),&login.login_id,|_|true).unwrap();
    assert_eq!(poll_login(f.base.path(),&login.login_id,|_|true).unwrap().state,"failed");
    assert_eq!(begin_login(f.base.path(),f.provider,&f.id,|_|true,f.source.path()).unwrap_err(),ERR_HOME_IN_USE);
    assert_eq!(f.begin().home.state,HomeState::AwaitingLogin);
}

#[test]
fn account_homes_grok_hooks_paths_are_copied_and_removed_hooks_are_retired() {
    let f=Fixture::new(CliProvider::Grok);
    fs::create_dir_all(f.source.path().join("hooks-paths")).unwrap();
    fs::write(f.source.path().join("hooks-paths/fixture.json"),"{}").unwrap();
    fs::create_dir_all(f.source.path().join("hooks")).unwrap();
    fs::write(f.source.path().join("hooks/old.json"),"{}").unwrap(); f.ready();
    assert!(!is_link(&fs::symlink_metadata(f.home().join("hooks-paths")).unwrap()));
    fs::rename(f.source.path().join("hooks/old.json"),f.source.path().join("retained-fixture.json")).unwrap();
    f.launch("work",|_|false).unwrap();
    assert!(!f.home().join("hooks/old.json").exists()); assert!(f.home().join(".retired-settings").is_dir());
}

#[test]
fn account_homes_identity_only_or_empty_credentials_never_finish_login_or_launch() {
    for provider in [CliProvider::Codex,CliProvider::Grok] {
        let f=Fixture::new(provider); f.ready();
        let incomplete=if provider==CliProvider::Codex { serde_json::json!({"tokens":{"account_id":"owner-fixture","access_token":""}}) }
            else { serde_json::json!({"https://fixture.invalid":{"user_id":"owner-fixture","email":"fixture@example.test"}}) };
        fs::write(f.home().join("auth.json"),serde_json::to_vec(&incomplete).unwrap()).unwrap();
        assert_eq!(f.launch("work",|_|false).unwrap_err(),ERR_HOME_NOT_READY);
        assert_eq!(list(f.base.path()).unwrap()[0].state,HomeState::NeedsLogin);
        let login=f.begin(); claim_login(f.base.path(),&login.login_id,"new-login").unwrap(); finish_login_launch(&login.login_id,true);
        let mut changed=incomplete; changed.as_object_mut().unwrap().insert("fixture_changed".into(),serde_json::Value::Bool(true));
        fs::write(f.home().join("auth.json"),serde_json::to_vec(&changed).unwrap()).unwrap();
        poll_login(f.base.path(),&login.login_id,|_|false).unwrap();
        let status=poll_login(f.base.path(),&login.login_id,|_|false).unwrap();
        assert_eq!(status.state,"failed"); assert_eq!(status.reason.as_deref(),Some(ERR_HOME_NOT_READY));
        assert_eq!(list(f.base.path()).unwrap()[0].state,HomeState::AwaitingLogin);
    }
}

#[cfg(unix)]
#[test]
fn fixr_r02_nested_grok_databases_reject_symlinks_and_hardlinks_on_launch_and_login() {
    use std::os::unix::fs::symlink;
    for name in ["session_search.sqlite", "session_search.sqlite-wal"] {
        for hardlink in [false, true] {
            let f = Fixture::new(CliProvider::Grok); f.ready();
            let outside = tempdir().unwrap();
            let external = outside.path().join("global-db"); fs::write(&external, b"outside sentinel").unwrap();
            fs::create_dir_all(f.home().join("sessions/deeper")).unwrap();
            let target = f.home().join("sessions/deeper").join(name);
            if hardlink { fs::hard_link(&external, &target).unwrap(); }
            else { symlink(&external, &target).unwrap(); }
            assert_eq!(f.launch("tab", |_| false).unwrap_err(), ERR_HOME_PATH_INVALID);
            assert_eq!(begin_login(f.base.path(), f.provider, &f.id, |_| false, f.source.path()).unwrap_err(), ERR_HOME_PATH_INVALID);
            assert_eq!(fs::read(&external).unwrap(), b"outside sentinel");
        }
    }
}

#[cfg(unix)]
#[test]
fn fixr_r02_nested_directory_links_are_refused_even_under_a_plain_skills_folder() {
    use std::os::unix::fs::symlink;
    for name in ["sessions/deeper/runtime", "sessions/deeper/skills", "skills/deeper"] {
        let f = Fixture::new(CliProvider::Grok); f.ready();
        let outside = tempdir().unwrap();
        let target = f.home().join(name);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        symlink(outside.path(), &target).unwrap();
        assert_eq!(f.launch("tab", |_| false).unwrap_err(), ERR_HOME_PATH_INVALID);
        assert_eq!(begin_login(f.base.path(), f.provider, &f.id, |_| false, f.source.path()).unwrap_err(), ERR_HOME_PATH_INVALID);
    }
}

#[cfg(unix)]
#[test]
fn fixr_r02_claim_login_rechecks_nested_links_and_allowed_asset_links_are_not_walked() {
    use std::os::unix::fs::symlink;
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let f = Fixture::new(provider);
        let outside = tempdir().unwrap();
        fs::create_dir(f.source.path().join("skills")).unwrap();
        symlink(outside.path(), f.source.path().join("skills/embedded")).unwrap();
        f.ready();
        assert!(is_link(&fs::symlink_metadata(f.home().join("skills")).unwrap()));
        f.launch("tab", |_| false).unwrap();
        let login = f.begin();
        fs::create_dir_all(f.home().join("sessions/deep")).unwrap();
        symlink(outside.path(), f.home().join("sessions/deep/runtime")).unwrap();
        assert_eq!(claim_login(f.base.path(), &login.login_id, "login").unwrap_err(), ERR_HOME_PATH_INVALID);
    }
}

#[cfg(unix)]
#[test]
fn fixr_r02_two_thousand_jsonl_files_use_only_link_attributes() {
    let f = Fixture::new(CliProvider::Grok); f.ready();
    let sessions = f.home().join("sessions/deep"); fs::create_dir_all(&sessions).unwrap();
    for index in 0..2000 { fs::write(sessions.join(format!("{index}.jsonl")), b"fixture\n").unwrap(); }
    // A JSONL hardlink is intentionally not opened for an nlink check.
    let outside = tempdir().unwrap();
    fs::hard_link(sessions.join("0.jsonl"), outside.path().join("conversation.jsonl")).unwrap();
    let started = Instant::now();
    home_path(f.base.path(), f.provider, &f.id, false, true).unwrap();
    let elapsed = started.elapsed();
    eprintln!("test result: R-02 home_path 2000 JSONL files elapsed_us={}", elapsed.as_micros());
    f.launch("tab", |_| false).unwrap();
    f.begin();
}

#[test]
fn fixr_r03_changed_setting_files_are_retired_once_and_identical_reflections_keep_the_digest() {
    for (provider, name, source, changed) in [
        (CliProvider::Codex, "config.toml", "model = 'source'\n", "model = 'x'\n"),
        (CliProvider::Codex, "AGENTS.md", "source instructions\n", "CLI instructions\n"),
        (CliProvider::Codex, "hooks.json", "{\"source\":true}\n", "{\"cli\":true}\n"),
        (CliProvider::Grok, "hooks-paths", "source path\n", "CLI path\n"),
        (CliProvider::Grok, "config.toml", "model = 'source'\n", "model = 'x'\n"),
    ] {
        let f = Fixture::new(provider);
        fs::write(f.source.path().join(name), source).unwrap(); f.ready();
        let expected = fs::read(f.home().join(name)).unwrap();
        assert!(!f.home().join(".retired-settings").exists());
        fs::write(f.home().join(name), changed).unwrap();
        f.launch("first", |_| false).unwrap();
        assert_eq!(fs::read(f.home().join(name)).unwrap(), expected);
        let retired = fs::read_dir(f.home().join(".retired-settings")).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(retired.len(), 1, "{name}");
        assert_eq!(fs::read(retired[0].path()).unwrap(), changed.as_bytes());
        let first_digest = read_manifest(f.base.path()).unwrap().homes[0].last_settings_digest.clone();
        f.launch("second", |_| false).unwrap();
        assert_eq!(fs::read_dir(f.home().join(".retired-settings")).unwrap().count(), 1, "{name}");
        assert_eq!(read_manifest(f.base.path()).unwrap().homes[0].last_settings_digest, first_digest);
    }
}

#[test]
fn fixr_r03_copied_trees_retire_only_changed_contents_including_removed_entries() {
    for (provider, name) in [(CliProvider::Grok, "hooks"), (CliProvider::Grok, "hooks-paths"), (CliProvider::Codex, "skills")] {
        let f = Fixture::new(provider); f.ready();
        for root in [f.source.path().join(name), f.home().join(name)] {
            fs::create_dir_all(root.join("deep/empty")).unwrap();
            fs::write(root.join("deep/config.json"), b"source").unwrap();
        }
        fs::write(f.home().join(name).join("deep/config.json"), b"CLI change").unwrap();
        f.launch("first", |_| false).unwrap();
        let retired = fs::read_dir(f.home().join(".retired-settings")).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(retired.len(), 1, "{name}");
        assert_eq!(fs::read(retired[0].path().join("deep/config.json")).unwrap(), b"CLI change");
        assert_eq!(fs::read(f.home().join(name).join("deep/config.json")).unwrap(), b"source");
        let first_digest = read_manifest(f.base.path()).unwrap().homes[0].last_settings_digest.clone();
        f.launch("same", |_| false).unwrap();
        assert_eq!(fs::read_dir(f.home().join(".retired-settings")).unwrap().count(), 1);
        assert_eq!(read_manifest(f.base.path()).unwrap().homes[0].last_settings_digest, first_digest);
        fs::rename(f.source.path().join(name).join("deep/empty"), f.source.path().join("retained-empty")).unwrap();
        f.launch("removed-empty-folder", |_| false).unwrap();
        assert!(!f.home().join(name).join("deep/empty").exists());
        assert_eq!(fs::read_dir(f.home().join(".retired-settings")).unwrap().count(), 2);
        fs::rename(f.home().join(name).join("deep/config.json"), f.home().join(name).join("deep/cli-only.json")).unwrap();
        fs::create_dir(f.home().join(name).join("deep/config.json")).unwrap();
        f.launch("changed-entry-type", |_| false).unwrap();
        assert!(f.home().join(name).join("deep/config.json").is_file());
        assert!(!f.home().join(name).join("deep/cli-only.json").exists());
        assert_eq!(fs::read_dir(f.home().join(".retired-settings")).unwrap().count(), 3);
        f.launch("same-after-entry-type", |_| false).unwrap();
        assert_eq!(fs::read_dir(f.home().join(".retired-settings")).unwrap().count(), 3);
    }
}

#[test]
fn fixr_r04_exited_login_finishes_after_another_accounts_launch_begin_or_unregister_prunes() {
    for operation in ["prepare_launch", "begin_login", "unregister"] {
        let f = Fixture::new(CliProvider::Codex); f.ready();
        let other_id = "codex-other-fixture";
        let mut profiles = registry::load(f.base.path()).unwrap();
        let mut other = profiles.profiles[0].clone(); other.id = other_id.into(); profiles.profiles.push(other);
        registry::save(f.base.path(), &profiles).unwrap();
        let other_login = begin_login(f.base.path(), f.provider, other_id, |_| false, f.source.path()).unwrap();
        let (_, _, _, other_home) = claim_login(f.base.path(), &other_login.login_id, "other-login").unwrap();
        finish_login_launch(&other_login.login_id, true);
        fs::write(other_home.join("auth.json"), fs::read(f.home().join("auth.json")).unwrap()).unwrap();
        poll_login(f.base.path(), &other_login.login_id, |_| false).unwrap();
        assert_eq!(poll_login(f.base.path(), &other_login.login_id, |_| false).unwrap().state, "ready");
        let login = f.begin(); claim_login(f.base.path(), &login.login_id, "exited-login").unwrap();
        finish_login_launch(&login.login_id, true);
        let mut auth: serde_json::Value = serde_json::from_slice(&fs::read(f.home().join("auth.json")).unwrap()).unwrap();
        auth["fixture_new_login"] = true.into();
        fs::write(f.home().join("auth.json"), serde_json::to_vec(&auth).unwrap()).unwrap();
        assert_eq!(poll_login(f.base.path(), &login.login_id, |_| false).unwrap().state, "pending");
        match operation {
            "prepare_launch" => { prepare_launch(f.base.path(), f.provider, other_id, "other-tab", |_| false, f.source.path()).unwrap(); }
            "begin_login" => { begin_login(f.base.path(), f.provider, other_id, |_| false, f.source.path()).unwrap(); }
            _ => { unregister(f.base.path(), f.provider, other_id, |_| false).unwrap(); }
        }
        assert!(runtime().logins[&login.login_id].launched);
        assert!(!in_use(&runtime(), &key(f.base.path(), f.provider, &f.id).unwrap(), &|_| false));
        let ready = poll_login(f.base.path(), &login.login_id, |_| false).unwrap();
        assert_eq!(ready.state, "ready", "{operation}"); assert_eq!(ready.home.generation, 2);
        assert_eq!(poll_login(f.base.path(), &login.login_id, |_| false).unwrap().home.generation, 2);
        f.launch("after-login", |_| false).unwrap();
        unregister(f.base.path(), f.provider, &f.id, |_| false).unwrap();
        assert!(list(f.base.path()).unwrap().iter().all(|home| home.profile_id != f.id));
        assert_eq!(f.begin().state, "pending");
    }
}

#[test]
fn fixr_r04_exited_login_still_checks_stable_owner_and_cancels_unchanged_auth() {
    for reason in ["owner", "unchanged", "absent"] {
        let f = Fixture::new(CliProvider::Grok); f.ready();
        let login = f.begin(); claim_login(f.base.path(), &login.login_id, "exited").unwrap();
        finish_login_launch(&login.login_id, true);
        if reason == "owner" { f.auth("other-owner"); }
        if reason == "absent" { fs::rename(f.home().join("auth.json"), f.home().join("retained-auth.fixture")).unwrap(); }
        prune(&mut runtime(), &f.base.path().canonicalize().unwrap(), &|_| false);
        let first = poll_login(f.base.path(), &login.login_id, |_| false).unwrap();
        let status = if reason == "owner" {
            assert_eq!(first.state, "pending");
            poll_login(f.base.path(), &login.login_id, |_| false).unwrap()
        } else { first };
        assert_eq!(status.state, "failed");
        assert_eq!(status.reason.as_deref(), Some(if reason == "owner" { ERR_HOME_OWNER_MISMATCH } else { super::super::ERR_LOGIN_CANCELLED }));
        assert!(!in_use(&runtime(), &key(f.base.path(), f.provider, &f.id).unwrap(), &|_| false));
    }
}

#[cfg(unix)]
#[test]
fn fixr2_retired_rules_link_allows_the_next_launch_and_login() {
    let f = Fixture::new(CliProvider::Codex);
    fs::create_dir(f.source.path().join("rules")).unwrap();
    fs::write(f.source.path().join("rules/instructions.md"), b"source rules").unwrap();
    f.ready();
    let original_target = fs::read_link(f.home().join("rules")).unwrap();
    // Make the source disappear without deleting the fixture or its content.
    fs::rename(f.source.path().join("rules"), f.source.path().join("removed-rules.fixture")).unwrap();
    f.launch("retire-rules", |_| false).unwrap();
    assert!(fs::symlink_metadata(f.home().join("rules")).is_err());
    let retired: Vec<_> = fs::read_dir(f.home().join(".retired-settings")).unwrap().map(|entry| entry.unwrap().path()).collect();
    assert_eq!(retired.len(), 1);
    assert!(is_link(&fs::symlink_metadata(&retired[0]).unwrap()));
    assert_eq!(fs::read_link(&retired[0]).unwrap(), original_target);
    assert!(!retired[0].exists(), "the retired fixture link is dangling");
    f.launch("after-retirement", |_| false).unwrap();
    assert_eq!(fs::read_dir(f.home().join(".retired-settings")).unwrap().count(), 1);
    let login = f.begin();
    claim_login(f.base.path(), &login.login_id, "login-after-retirement").unwrap();
    assert_eq!(fs::read(f.source.path().join("removed-rules.fixture/instructions.md")).unwrap(), b"source rules");
}

#[cfg(unix)]
#[test]
fn fixr2_retargeted_skills_link_is_retired_without_blocking_the_home() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(CliProvider::Codex);
    let original = tempdir().unwrap(); let replacement = tempdir().unwrap();
    fs::write(original.path().join("skill.md"), b"original skill").unwrap();
    fs::write(replacement.path().join("skill.md"), b"replacement skill").unwrap();
    symlink(original.path(), f.source.path().join("skills")).unwrap();
    f.ready();
    let original_target = fs::read_link(f.home().join("skills")).unwrap();
    fs::rename(f.source.path().join("skills"), f.source.path().join("previous-skills.fixture")).unwrap();
    symlink(replacement.path(), f.source.path().join("skills")).unwrap();
    f.launch("retarget-skills", |_| false).unwrap();
    assert_eq!(fs::read_link(f.home().join("skills")).unwrap(), replacement.path().canonicalize().unwrap());
    let retired: Vec<_> = fs::read_dir(f.home().join(".retired-settings")).unwrap().map(|entry| entry.unwrap().path()).collect();
    assert_eq!(retired.len(), 1);
    assert!(is_link(&fs::symlink_metadata(&retired[0]).unwrap()));
    assert_eq!(fs::read_link(&retired[0]).unwrap(), original_target);
    f.launch("after-retarget", |_| false).unwrap();
    assert_eq!(fs::read_dir(f.home().join(".retired-settings")).unwrap().count(), 1);
    let login = f.begin();
    claim_login(f.base.path(), &login.login_id, "login-after-retarget").unwrap();
    assert_eq!(fs::read(original.path().join("skill.md")).unwrap(), b"original skill");
    assert_eq!(fs::read(replacement.path().join("skill.md")).unwrap(), b"replacement skill");
}

#[cfg(unix)]
#[test]
fn fixr2_a_linked_retired_settings_container_is_refused_in_both_check_modes() {
    use std::os::unix::fs::symlink;
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        let f = Fixture::new(provider); f.ready();
        let outside = tempdir().unwrap();
        symlink(outside.path(), f.home().join(".retired-settings")).unwrap();
        for deep_check in [false, true] {
            assert_eq!(home_path(f.base.path(), provider, &f.id, false, deep_check).unwrap_err(), ERR_HOME_PATH_INVALID);
        }
        assert_eq!(f.launch("refused", |_| false).unwrap_err(), ERR_HOME_PATH_INVALID);
        assert_eq!(begin_login(f.base.path(), provider, &f.id, |_| false, f.source.path()).unwrap_err(), ERR_HOME_PATH_INVALID);
    }
}

#[cfg(unix)]
#[test]
fn fixr2_context_and_login_poll_are_shallow_but_startup_and_claim_check_nested_links() {
    use std::os::unix::fs::symlink;
    for provider in [CliProvider::Codex, CliProvider::Grok] {
        for nested in ["memories/x", "memories/.retired-settings/x"] {
            let f = Fixture::new(provider); f.ready();
            let mut active = f.launch("running", |_| false).unwrap(); active.commit();
            let outside = tempdir().unwrap();
            let target = f.home().join(nested);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            symlink(outside.path(), &target).unwrap();
            assert_eq!(context_for_session(f.base.path(), "running").unwrap().unwrap().home(), f.home().canonicalize().unwrap());
            assert_eq!(f.launch("refused-new-cli", |id| id == "running").unwrap_err(), ERR_HOME_PATH_INVALID);
            assert!(context_for_session(f.base.path(), "running").unwrap().is_some());
            assert_eq!(begin_login(f.base.path(), provider, &f.id, |_| false, f.source.path()).unwrap_err(), ERR_HOME_PATH_INVALID);

            let login_fixture = Fixture::new(provider);
            let login = login_fixture.begin();
            claim_login(login_fixture.base.path(), &login.login_id, "login").unwrap();
            finish_login_launch(&login.login_id, true);
            login_fixture.auth("owner-fixture");
            let target = login_fixture.home().join(nested);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            symlink(outside.path(), &target).unwrap();
            assert_eq!(claim_login(login_fixture.base.path(), &login.login_id, "login").unwrap_err(), ERR_HOME_PATH_INVALID);
            assert_eq!(poll_login(login_fixture.base.path(), &login.login_id, |_| false).unwrap().state, "pending");
            assert_eq!(poll_login(login_fixture.base.path(), &login.login_id, |_| false).unwrap().state, "ready");
            assert_eq!(login_fixture.launch("refused-after-login", |_| false).unwrap_err(), ERR_HOME_PATH_INVALID);
        }
    }
}
