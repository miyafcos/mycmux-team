//! Persistent CLI-owned authentication. Never seed, export, refresh or capture credentials.
//! Only the provider's identity reader is allowed to inspect a home's auth file.
use std::{collections::HashMap, fs, io::Write, path::{Path, PathBuf}, sync::{Mutex, MutexGuard, OnceLock}, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use super::{codex, grok, registry, snapshot, staging, CliProvider, ERR_LAUNCH_ACCOUNT_NOT_FOUND};

pub const ERR_HOME_NOT_READY: &str = "cli_account.error.home_not_ready";
pub const ERR_HOME_OWNER_MISMATCH: &str = "cli_account.error.home_owner_mismatch";
pub const ERR_HOME_ISOLATION_UNAVAILABLE: &str = "cli_account.error.home_isolation_unavailable";
pub const ERR_HOME_IN_USE: &str = "cli_account.error.home_in_use";
pub const ERR_HOME_PATH_INVALID: &str = "cli_account.error.home_path_invalid";
pub const HOME_ENV_KEYS: &[&str] = &["CODEX_HOME", "GROK_HOME", "CODEX_SQLITE_HOME", "GROK_AUTH_PATH", "GROK_LEADER_SOCKET", "MYCMUX_ACCOUNT_HOME_KIND", "MYCMUX_CLI_LOGIN_ID"];
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HomeState { Created, AwaitingLogin, Ready, NeedsLogin }

/// This is also the complete public home representation. No filesystem paths.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct AccountHomeStatus {
    pub provider: CliProvider,
    pub profile_id: String,
    pub state: HomeState,
    pub owner: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct HomeRecord {
    #[serde(flatten)] status: AccountHomeStatus,
    created_at: String,
    updated_at: String,
    last_settings_digest: Option<String>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest { homes: Vec<HomeRecord> }

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LoginPurpose {
    #[default] GlobalStaging,
    AccountHome { profile_id: String },
}

#[derive(Clone, Debug, Serialize)]
pub struct HomeLoginStatus {
    pub login_id: String,
    pub provider: CliProvider,
    pub profile_id: String,
    pub state: String,
    pub reason: Option<String>,
    pub home: AccountHomeStatus,
}

#[derive(Clone, PartialEq, Eq)]
struct HomeKey { base: PathBuf, provider: CliProvider, profile_id: String }
struct ActiveHome { key: HomeKey, reserved: bool }
struct PendingHomeLogin {
    key: HomeKey,
    status: HomeLoginStatus,
    started: Instant,
    session_id: Option<String>,
    cancelled: bool,
    launched: bool,
    initial_auth: Option<String>,
    candidate: Option<String>,
}
#[derive(Default)]
struct Runtime {
    sessions: HashMap<(PathBuf, String), ActiveHome>,
    logins: HashMap<String, PendingHomeLogin>,
}
static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
fn runtime() -> MutexGuard<'static, Runtime> {
    RUNTIME.get_or_init(|| Mutex::new(Runtime::default())).lock().unwrap_or_else(|e| e.into_inner())
}
fn unavailable<T>(_: T) -> String { ERR_HOME_ISOLATION_UNAVAILABLE.into() }
fn invalid<T>(_: T) -> String { ERR_HOME_PATH_INVALID.into() }
fn now() -> String { chrono::Utc::now().to_rfc3339() }
/// Read-only validation shared with the record catalog; no registry/auth access.
pub(crate) fn valid_record_profile_id(id: &str) -> bool { snapshot::validate_snapshot_id(id).is_ok() }
pub fn provider_name(provider: CliProvider) -> Result<&'static str, String> {
    match provider { CliProvider::Codex => Ok("codex"), CliProvider::Grok => Ok("grok"), _ => Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()) }
}
fn profile(base: &Path, provider: CliProvider, id: &str) -> Result<super::CliAccountProfile, String> {
    snapshot::validate_snapshot_id(id).map_err(invalid)?;
    provider_name(provider)?;
    registry::load(base).map_err(unavailable)?.profiles.into_iter()
        .find(|p| p.id == id && p.provider == provider)
        .ok_or_else(|| ERR_LAUNCH_ACCOUNT_NOT_FOUND.into())
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; meta.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { meta.file_type().is_symlink() }
}
fn private_dir(path: &Path) -> Result<(), String> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if is_link(&meta) || !meta.is_dir() { return Err(ERR_HOME_PATH_INVALID.into()); }
    } else { fs::create_dir(path).map_err(unavailable)?; }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(unavailable)?; }
    Ok(())
}
fn regular_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ERR_HOME_PATH_INVALID.into()),
        Ok(meta) => {
            if is_link(&meta) || !meta.is_file() { return Err(ERR_HOME_PATH_INVALID.into()); }
            #[cfg(unix)] { use std::os::unix::fs::MetadataExt; if meta.nlink() != 1 { return Err(ERR_HOME_PATH_INVALID.into()); } }
            #[cfg(windows)]
            {
                use std::os::windows::io::AsRawHandle;
                #[link(name = "kernel32")]
                extern "system" { fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, information: *mut u32) -> i32; }
                // BY_HANDLE_FILE_INFORMATION consists of thirteen DWORDs; the
                // eleventh is nNumberOfLinks. No additional Windows features.
                let file = fs::File::open(path).map_err(invalid)?;
                let mut information = [0u32; 13];
                let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
                if ok == 0 || information[10] != 1 { return Err(ERR_HOME_PATH_INVALID.into()); }
            }
            Ok(())
        }
    }
}
fn root(base: &Path, create: bool) -> Result<PathBuf, String> {
    let base = base.canonicalize().map_err(invalid)?;
    // The Windows fallback relies on the user's roaming AppData ACL. Refuse
    // an externally redirected application root rather than claiming that ACL.
    #[cfg(all(windows, not(test)))]
    {
        let roaming = std::env::var_os("APPDATA").ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
        let roaming = PathBuf::from(roaming).canonicalize().map_err(unavailable)?;
        if !base.starts_with(roaming) { return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
    }
    let path = base.join("cli_account_homes");
    if create { private_dir(&path)?; }
    if path.exists() {
        if is_link(&fs::symlink_metadata(&path).map_err(invalid)?) { return Err(ERR_HOME_PATH_INVALID.into()); }
        let canonical = path.canonicalize().map_err(invalid)?;
        if canonical.parent() != Some(base.as_path()) { return Err(ERR_HOME_PATH_INVALID.into()); }
    }
    Ok(path)
}
fn home_path(base: &Path, provider: CliProvider, id: &str, create: bool, deep_check: bool) -> Result<PathBuf, String> {
    snapshot::validate_snapshot_id(id).map_err(invalid)?;
    let root = root(base, create)?;
    let provider_dir = root.join(provider_name(provider)?);
    let home = provider_dir.join(id);
    for path in [&provider_dir, &home] {
        if create { private_dir(path)?; }
        if !path.exists() { return Err(ERR_HOME_NOT_READY.into()); }
        let meta = fs::symlink_metadata(path).map_err(invalid)?;
        if is_link(&meta) || !meta.is_dir() { return Err(ERR_HOME_PATH_INVALID.into()); }
    }
    let canonical = home.canonicalize().map_err(invalid)?;
    if canonical.parent() != Some(provider_dir.canonicalize().map_err(invalid)?.as_path())
        || !canonical.starts_with(root.canonicalize().map_err(invalid)?) { return Err(ERR_HOME_PATH_INVALID.into()); }
    // Credentials and mutable state must remain private, including links that
    // would point to a sibling home rather than outside the application root.
    let mut directories = vec![home.clone()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory).map_err(invalid)? {
            let entry = entry.map_err(invalid)?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let allowed_link = directory == home && matches!((provider, name.as_ref()),
                (CliProvider::Codex, "skills" | "rules" | "prompts") | (CliProvider::Grok, "skills"));
            let meta = fs::symlink_metadata(&path).map_err(invalid)?;
            if is_link(&meta) {
                if allowed_link { continue; }
                return Err(ERR_HOME_PATH_INVALID.into());
            }
            // Only CLI startup needs the full mutable-state check. Retired
            // assets are not read by the CLI; still reject a linked container above.
            if meta.is_dir() && deep_check && !(directory == home && name == ".retired-settings") { directories.push(path); }
            else if meta.is_file() && path.extension().is_none_or(|ext| ext != "jsonl") {
                // JSONL history needs the link-attribute check above, without
                // opening every conversation file for Windows' nlink check.
                regular_file(&path)?;
            }
        }
    }
    Ok(canonical)
}
fn read_manifest(base: &Path) -> Result<Manifest, String> {
    if !base.exists() { return Ok(Manifest::default()); }
    let path = root(base, false)?.join("manifest.json");
    regular_file(&path)?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(unavailable),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(_) => Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()),
    }
}
fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    regular_file(path)?;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or_else(|| ERR_HOME_PATH_INVALID.to_string())?).map_err(unavailable)?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; temp.as_file().set_permissions(fs::Permissions::from_mode(0o600)).map_err(unavailable)?; }
    temp.write_all(contents).map_err(unavailable)?;
    temp.as_file().sync_all().map_err(unavailable)?;
    temp.persist(path).map_err(unavailable)?;
    Ok(())
}
fn save_manifest(base: &Path, manifest: &Manifest) -> Result<(), String> {
    let path = root(base, true)?.join("manifest.json");
    write_private(&path, &serde_json::to_vec_pretty(manifest).map_err(unavailable)?)
}
fn key(base: &Path, provider: CliProvider, id: &str) -> Result<HomeKey, String> {
    Ok(HomeKey { base: base.canonicalize().map_err(invalid)?, provider, profile_id: id.into() })
}
fn prune(runtime: &mut Runtime, base: &Path, alive: &impl Fn(&str) -> bool) {
    runtime.sessions.retain(|(_, id), active| active.key.base != base || active.reserved || alive(id));
    // A launched login still needs its final stable-auth poll after PTY exit.
}
fn in_use(runtime: &Runtime, key: &HomeKey, alive: &impl Fn(&str) -> bool) -> bool {
    runtime.sessions.values().any(|active| &active.key == key)
        || runtime.logins.values().any(|pending| &pending.key == key && pending.launched
            && pending.session_id.as_deref().is_some_and(alive))
}
fn login_in_progress(runtime: &Runtime, key: &HomeKey) -> bool {
    runtime.logins.values().any(|pending| &pending.key == key && pending.status.state == "pending")
}
fn check_owner(home: &Path, provider: CliProvider, identity: &str) -> Result<Option<String>, String> {
    regular_file(&home.join("auth.json"))?;
    let bytes = read_optional(&home.join("auth.json"))?.ok_or_else(|| ERR_HOME_NOT_READY.to_string())?;
    let auth: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ERR_HOME_NOT_READY.to_string())?;
    // Identity-only or half-written JSON is not a finished login. Do not
    // inspect expiry or refresh tokens, and never return credential values.
    let credential = match provider {
        CliProvider::Codex => auth.get("tokens").and_then(|tokens| tokens.get("access_token")).and_then(|value| value.as_str()),
        CliProvider::Grok => auth.as_object().and_then(|root| root.values().find_map(|value| value.as_object()))
            .and_then(|entry| entry.get("key")).and_then(|value| value.as_str()),
        _ => None,
    };
    if !credential.is_some_and(|value| !value.trim().is_empty()) { return Err(ERR_HOME_NOT_READY.into()); }
    let login = match provider {
        CliProvider::Codex => codex::read_live_identity(&codex::CodexPaths { auth: home.join("auth.json") }),
        CliProvider::Grok => grok::read_live_identity(&grok::GrokPaths { auth: home.join("auth.json"), lock: home.join("auth.json.lock") }),
        _ => return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()),
    };
    if !login.present || login.error.is_some() || login.identity_key.is_none() { return Err(ERR_HOME_NOT_READY.into()); }
    if login.identity_key.as_deref() != Some(identity) { return Err(ERR_HOME_OWNER_MISMATCH.into()); }
    Ok(login.email)
}

/// Backend-only capability. Debug intentionally excludes the home path.
pub struct AccountLaunchContext { pub provider: CliProvider, pub profile_id: String, pub generation: u64,
    pub(crate) owner_email: Option<String>, pub(crate) owner_checked_at: Option<String>,
    home: PathBuf, reservation: Option<(PathBuf, String)> }
impl std::fmt::Debug for AccountLaunchContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountLaunchContext").field("provider", &self.provider).field("profile_id", &self.profile_id).field("generation", &self.generation).finish_non_exhaustive()
    }
}
impl AccountLaunchContext {
    pub fn home(&self) -> &Path { &self.home }
    pub fn session_roots(&self) -> Vec<PathBuf> {
        let mut roots = vec![self.home.join("sessions")];
        if self.provider == CliProvider::Codex { roots.push(self.home.join("archived_sessions")); }
        roots
    }
    pub fn apply_env(&self, env: &mut HashMap<String, String>) {
        env.retain(|name, _| !HOME_ENV_KEYS.iter().chain(provider_auth_keys(self.provider).iter()).any(|key| name.eq_ignore_ascii_case(key)));
        env.insert(if self.provider == CliProvider::Codex { "CODEX_HOME" } else { "GROK_HOME" }.into(), self.home.to_string_lossy().into_owned());
        env.insert("MYCMUX_ACCOUNT_HOME_KIND".into(), provider_name(self.provider).expect("validated provider").into());
    }
    pub fn commit(&mut self) {
        if let Some(id) = self.reservation.take() { if let Some(active) = runtime().sessions.get_mut(&id) { active.reserved = false; } }
    }
}
#[cfg(test)]
pub(crate) fn test_context(provider: CliProvider, home: PathBuf) -> AccountLaunchContext {
    AccountLaunchContext { provider, profile_id: "fixture-only".into(), generation: 1, owner_email: None, owner_checked_at: None, home, reservation: None }
}
impl Drop for AccountLaunchContext {
    fn drop(&mut self) { if let Some(id) = self.reservation.take() { runtime().sessions.remove(&id); } }
}
pub fn global_home(provider: CliProvider) -> Result<PathBuf, String> {
    let auth = match provider { CliProvider::Codex => codex::CodexPaths::resolve().map_err(unavailable)?.auth,
        CliProvider::Grok => grok::GrokPaths::resolve().map_err(unavailable)?.auth, _ => return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()) };
    auth.parent().map(Path::to_path_buf).ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.into())
}
pub fn provider_auth_keys(provider: CliProvider) -> &'static [&'static str] {
    match provider { CliProvider::Codex => &["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "OPENAI_AUTH_TOKEN"],
        CliProvider::Grok => &["XAI_API_KEY", "GROK_API_KEY", "GROK_ACCESS_TOKEN"], _ => &[] }
}
/// An ordinary tab has no runtime home entry, including on first launch when
/// the application data directory has not been created yet. Do not probe it.
pub(crate) fn record_context_for_session(base: &Path, session_id: &str) -> Result<Option<AccountLaunchContext>, String> {
    let recorded = runtime().sessions.keys().any(|(_, id)| id == session_id);
    if !recorded { return Ok(None); }
    context_for_session(base, session_id)
}
/// 2B can use this backend-only provenance without recovering a path from env.
pub fn context_for_session(base: &Path, session_id: &str) -> Result<Option<AccountLaunchContext>, String> {
    let rt = runtime();
    let canonical_base = base.canonicalize().map_err(invalid)?;
    let Some(active) = rt.sessions.get(&(canonical_base, session_id.into())) else { return Ok(None); };
    let key = &active.key;
    profile(base, key.provider, &key.profile_id)?;
    let record = read_manifest(base)?.homes.into_iter().find(|h| h.status.provider == key.provider && h.status.profile_id == key.profile_id).ok_or_else(|| ERR_HOME_NOT_READY.to_string())?;
    Ok(Some(AccountLaunchContext { provider: key.provider, profile_id: key.profile_id.clone(), generation: record.status.generation,
        home: home_path(base, key.provider, &key.profile_id, false, false)?, owner_email: None, owner_checked_at: None, reservation: None }))
}
pub fn list(base: &Path) -> Result<Vec<AccountHomeStatus>, String> {
    let _guard = runtime();
    let profiles = registry::load(base).map_err(unavailable)?.profiles;
    Ok(read_manifest(base)?.homes.into_iter().filter(|h| profiles.iter().any(|p| p.id == h.status.profile_id && p.provider == h.status.provider)).map(|h| h.status).collect())
}
pub fn prepare_launch(base: &Path, provider: CliProvider, id: &str, session_id: &str, alive: impl Fn(&str) -> bool, source: &Path) -> Result<AccountLaunchContext, String> {
    let mut rt = runtime();
    let canonical_base = base.canonicalize().map_err(invalid)?;
    prune(&mut rt, &canonical_base, &alive);
    let profile = profile(base, provider, id)?;
    let key = key(base, provider, id)?;
    if login_in_progress(&rt, &key) { return Err(ERR_HOME_NOT_READY.into()); }
    let mut manifest = read_manifest(base)?;
    let record = manifest.homes.iter_mut().find(|h| h.status.provider == provider && h.status.profile_id == id).ok_or_else(|| ERR_HOME_NOT_READY.to_string())?;
    if record.status.state != HomeState::Ready { return Err(ERR_HOME_NOT_READY.into()); }
    let home = home_path(base, provider, id, false, true)?;
    let owner_email = match check_owner(&home, provider, &profile.identity_key) {
        Ok(email) => email,
        Err(reason) => {
            if reason == ERR_HOME_PATH_INVALID { return Err(reason); }
            record.status.state = HomeState::NeedsLogin;
            record.status.owner = "unverified".into(); record.updated_at = now();
            save_manifest(base, &manifest)?;
            return Err(reason);
        }
    };
    let owner_checked_at = Some(now());
    if !in_use(&rt, &key, &alive) {
        record.last_settings_digest = Some(reflect_settings(provider, source, &home)?);
        record.updated_at = now();
    }
    let generation = record.status.generation;
    save_manifest(base, &manifest)?;
    let reservation = (canonical_base, session_id.into());
    rt.sessions.insert(reservation.clone(), ActiveHome { key, reserved: true });
    Ok(AccountLaunchContext { provider, profile_id: id.into(), generation, owner_email, owner_checked_at, home, reservation: Some(reservation) })
}
/// Identity-only recheck: inspect this home and auth.json, never descend into its history.
pub(crate) fn recheck_owner(base: &Path, provider: CliProvider, id: &str) -> Result<Option<String>, String> {
    let _guard = runtime();
    let profile = profile(base, provider, id)?;
    let home = home_path(base, provider, id, false, false)?;
    check_owner(&home, provider, &profile.identity_key)
}

/// Unregister only the home manifest entry, leaving every home file in place.
pub fn unregister(base: &Path, provider: CliProvider, id: &str, alive: impl Fn(&str) -> bool) -> Result<(), String> {
    unregister_and(base, provider, id, alive, || Ok(()))
}
pub fn unregister_and(base: &Path, provider: CliProvider, id: &str, alive: impl Fn(&str) -> bool, operation: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let mut rt = runtime();
    prune(&mut rt, &base.canonicalize().map_err(invalid)?, &alive);
    profile(base, provider, id)?;
    let key = key(base, provider, id)?;
    if in_use(&rt, &key, &alive) || login_in_progress(&rt, &key) { return Err(ERR_HOME_IN_USE.into()); }
    let manifest = read_manifest(base)?;
    let old = serde_json::to_vec(&manifest).map_err(unavailable)?;
    let mut updated: Manifest = serde_json::from_slice(&old).map_err(unavailable)?;
    updated.homes.retain(|h| h.status.profile_id != id || h.status.provider != provider);
    save_manifest(base, &updated)?;
    if let Err(error) = operation() { save_manifest(base, &manifest)?; return Err(error); }
    Ok(())
}

// TOML's serializer feature is deliberately disabled in this repository. Use
// parser-proven value/key spans and reparse the generated document before IO.
fn emit_table(table: &dyn toml_edit::TableLike, source: &str, path: &[String], array: bool, out: &mut String) -> Result<(), String> {
    let header = path.iter().map(|key| serde_json::to_string(key).map_err(unavailable)).collect::<Result<Vec<_>, _>>()?.join(".");
    out.push_str(&format!("\n{}{}{}\n", if array { "[[" } else { "[" }, header, if array { "]]" } else { "]" }));
    for (key, item) in table.iter() {
        if let Some(value) = item.as_value() {
            let span = value.span().ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
            out.push_str(&serde_json::to_string(key).map_err(unavailable)?);
            out.push_str(" = "); out.push_str(&source[span]); out.push('\n');
        }
    }
    for (key, item) in table.iter() {
        let mut child = path.to_vec(); child.push(key.into());
        if let Some(table) = item.as_table() { emit_table(table, source, &child, false, out)?; }
        if let Some(tables) = item.as_array_of_tables() { for table in tables { emit_table(table, source, &child, true, out)?; } }
    }
    Ok(())
}
fn config_text(provider: CliProvider, source: &str, local: &str) -> Result<String, String> {
    let document = toml_edit::Document::parse(source).map_err(unavailable)?;
    let local_doc = toml_edit::Document::parse(if provider == CliProvider::Codex { local } else { "" }).map_err(unavailable)?;
    let mut output = source.to_string();
    if provider == CliProvider::Codex {
        let mut removals = Vec::new();
        let inline_projects = document.get("projects").is_some_and(|item| item.as_inline_table().is_some());
        for name in ["cli_auth_credentials_store", "sqlite_home", "log_dir", "projects"] {
            if name == "projects" && !inline_projects { continue; }
            if let Some(item) = document.get(name) {
                let value = item.as_value().ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
                let key_span = document.as_table().key(name).and_then(|key| key.span()).ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
                let value_span = value.span().ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
                let start = source[..key_span.start].rfind('\n').map_or(0, |i| i + 1);
                let end = source[value_span.end..].find('\n').map_or(source.len(), |i| value_span.end + i + 1);
                removals.push(start..end);
            }
        }
        removals.sort_by_key(|span| std::cmp::Reverse(span.start));
        for span in removals { output.replace_range(span, ""); }
        output.insert_str(0, "cli_auth_credentials_store = \"file\"\n");
        if inline_projects {
            emit_table(document["projects"].as_table_like().ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?, source, &["projects".into()], false, &mut output)?;
        }
        // A selectable profile can override the top-level storage locations.
        // Do not copy a profile that would escape the isolated home.
        if let Some(profiles) = document.get("profiles").and_then(|item| item.as_table_like()) {
            for (_, profile) in profiles.iter() {
                if profile.get("sqlite_home").is_some() || profile.get("log_dir").is_some()
                    || profile.get("cli_auth_credentials_store").is_some_and(|store| store.as_str() != Some("file")) {
                    return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into());
                }
            }
        }
    }
    // Grok G6 does not establish a project trust table name. Preserve no
    // private Grok edits; trusted_folders.toml is deliberately not distributed.
    let mut preserved = Vec::new();
    if provider == CliProvider::Codex {
        if let Some(projects) = local_doc.get("projects") {
            let projects = projects.as_table_like().ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
            for (name, project) in projects.iter() {
                if document.get("projects").and_then(|p| p.get(name)).is_some() { continue; }
                let table = project.as_table_like().ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
                let mut rendered = String::new();
                emit_table(table, local, &["projects".into(), name.into()], false, &mut rendered)?;
                output.push_str(&rendered);
                preserved.push((name.to_string(), rendered));
            }
        }
    }
    let checked = toml_edit::Document::parse(&output).map_err(unavailable)?;
    if provider == CliProvider::Codex {
        if checked.get("cli_auth_credentials_store").and_then(|i| i.as_str()) != Some("file")
            || checked.get("sqlite_home").is_some() || checked.get("log_dir").is_some() { return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
        for (name, expected) in preserved {
            let table = checked.get("projects").and_then(|p| p.get(&name)).and_then(|i| i.as_table_like()).ok_or_else(|| ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
            let mut rendered = String::new();
            emit_table(table, &output, &["projects".into(), name], false, &mut rendered)?;
            if rendered != expected { return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
        }
    }
    Ok(output)
}
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    regular_file(path)?;
    match fs::read(path) { Ok(bytes) => Ok(Some(bytes)), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(_) => Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()) }
}
fn digest(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }

/// Native Windows junction, using the existing kernel32 FFI style. No shell,
/// elevation or dependency; failure falls back to ordinary private copies.
#[cfg(windows)]
fn link_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" { fn DeviceIoControl(handle: *mut std::ffi::c_void, code: u32, input: *const u8, input_len: u32, output: *mut u8, output_len: u32, returned: *mut u32, overlapped: *mut std::ffi::c_void) -> i32; }
    fs::create_dir(target)?;
    let canonical = source.canonicalize()?;
    let display = canonical.to_string_lossy();
    let substitute = if let Some(unc) = display.strip_prefix(r"\\?\UNC\") { format!(r"\??\UNC\{unc}") }
        else if let Some(disk) = display.strip_prefix(r"\\?\") { format!(r"\??\{disk}") } else { format!(r"\??\{display}") };
    let subst: Vec<u16> = std::ffi::OsStr::new(&substitute).encode_wide().collect();
    let print: Vec<u16> = canonical.as_os_str().encode_wide().collect();
    let path_bytes = (subst.len() + 1 + print.len() + 1) * 2;
    let data_len = 8 + path_bytes;
    if data_len > 16_376 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "junction path too long")); }
    let mut buffer = Vec::with_capacity(8 + data_len);
    buffer.extend_from_slice(&0xa0000003u32.to_le_bytes());
    buffer.extend_from_slice(&(data_len as u16).to_le_bytes()); buffer.extend_from_slice(&0u16.to_le_bytes());
    for value in [0u16, (subst.len() * 2) as u16, ((subst.len() + 1) * 2) as u16, (print.len() * 2) as u16] { buffer.extend_from_slice(&value.to_le_bytes()); }
    for value in subst.into_iter().chain([0]).chain(print).chain([0]) { buffer.extend_from_slice(&value.to_le_bytes()); }
    let file = fs::OpenOptions::new().write(true).custom_flags(0x00200000 | 0x02000000).open(target)?;
    let mut returned = 0;
    let result = unsafe { DeviceIoControl(file.as_raw_handle(), 0x000900a4, buffer.as_ptr(), buffer.len() as u32, std::ptr::null_mut(), 0, &mut returned, std::ptr::null_mut()) };
    if result == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
}
#[cfg(unix)]
fn link_directory(source: &Path, target: &Path) -> std::io::Result<()> { std::os::unix::fs::symlink(source, target) }

// Compare actual copied trees, including removed files and empty folders.
// Linked source assets still follow the existing copy_tree refusal policy.
fn same_setting_tree(source: &Path, target: &Path) -> Result<bool, String> {
    let mut directories = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((source, target)) = directories.pop() {
        let source_meta = fs::symlink_metadata(&source).map_err(unavailable)?;
        if is_link(&source_meta) || !source_meta.is_dir() { return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
        let Ok(target_meta) = fs::symlink_metadata(&target) else { return Ok(false); };
        if is_link(&target_meta) || !target_meta.is_dir() { return Ok(false); }
        let mut entries = fs::read_dir(&source).map_err(unavailable)?.collect::<Result<Vec<_>, _>>().map_err(unavailable)?;
        entries.sort_by_key(|entry| entry.file_name());
        let mut targets = fs::read_dir(&target).map_err(unavailable)?.collect::<Result<Vec<_>, _>>().map_err(unavailable)?;
        targets.sort_by_key(|entry| entry.file_name());
        if entries.len() != targets.len() { return Ok(false); }
        for (entry, target) in entries.into_iter().zip(targets) {
            if entry.file_name() != target.file_name() { return Ok(false); }
            let meta = fs::symlink_metadata(entry.path()).map_err(unavailable)?;
            if is_link(&meta) { return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
            if meta.is_dir() { directories.push((entry.path(), target.path())); }
            else if meta.is_file() {
                regular_file(&entry.path())?;
                let target_meta = fs::symlink_metadata(target.path()).map_err(unavailable)?;
                if is_link(&target_meta) || !target_meta.is_file() { return Ok(false); }
                if read_optional(&target.path())?.as_deref() != Some(fs::read(entry.path()).map_err(unavailable)?.as_slice()) { return Ok(false); }
            } else { return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
        }
    }
    Ok(true)
}
fn write_setting(path: &Path, home: &Path, contents: &[u8]) -> Result<(), String> {
    if read_optional(path)?.as_deref() == Some(contents) { return Ok(()); }
    retire_setting(path, home)?;
    write_private(path, contents)
}
fn reflect_tree(source: &Path, target: &Path, home: &Path, hash: &mut Sha256) -> Result<(), String> {
    if !same_setting_tree(source, target)? { retire_setting(target, home)?; }
    copy_tree(source, target, home, hash)
}
fn copy_tree(source: &Path, target: &Path, home: &Path, hash: &mut Sha256) -> Result<(), String> {
    // Hooks reject links. Never follow an embedded link while copying assets.
    let meta = fs::symlink_metadata(source).map_err(unavailable)?;
    if is_link(&meta) { return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
    private_dir(target)?;
    let mut entries = fs::read_dir(source).map_err(unavailable)?.collect::<Result<Vec<_>, _>>().map_err(unavailable)?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let meta = fs::symlink_metadata(entry.path()).map_err(unavailable)?;
        hash.update(entry.file_name().to_string_lossy().as_bytes());
        if is_link(&meta) { return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
        if meta.is_dir() { copy_tree(&entry.path(), &target.join(entry.file_name()), home, hash)?; }
        else if meta.is_file() {
            regular_file(&entry.path())?;
            let bytes = fs::read(entry.path()).map_err(unavailable)?;
            write_setting(&target.join(entry.file_name()), home, &bytes)?; hash.update(&bytes);
        } else { return Err(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
    }
    Ok(())
}
fn reflect_settings(provider: CliProvider, source: &Path, home: &Path) -> Result<String, String> {
    let source_config = read_optional(&source.join("config.toml")).map_err(unavailable)?;
    let has_config = source_config.is_some() || provider == CliProvider::Codex;
    let raw = source_config.unwrap_or_default();
    let local = read_optional(&home.join("config.toml"))?.unwrap_or_default();
    let raw = std::str::from_utf8(&raw).map_err(unavailable)?;
    let local = if provider == CliProvider::Codex { std::str::from_utf8(&local).map_err(unavailable)? } else { "" };
    let rendered = config_text(provider, raw, local)?;
    let mut hash = Sha256::new(); hash.update(b"config.toml:file:"); hash.update(rendered.as_bytes());
    if has_config { write_setting(&home.join("config.toml"), home, rendered.as_bytes())?; }
    else { retire_setting(&home.join("config.toml"), home)?; hash.update(b"absent"); }
    let copies: &[&str] = if provider == CliProvider::Codex { &["AGENTS.md", "hooks.json"] } else { &["hooks-paths"] };
    for name in copies {
        hash.update(name.as_bytes());
        if provider == CliProvider::Grok && source.join(name).is_dir() {
            reflect_tree(&source.join(name), &home.join(name), home, &mut hash)?; hash.update(b"directory-copy");
        }
        else if let Some(bytes) = read_optional(&source.join(name))? { write_setting(&home.join(name), home, &bytes)?; hash.update(b"copied"); hash.update(&bytes); }
        else { retire_setting(&home.join(name), home)?; hash.update(b"absent"); }
    }
    let links: &[&str] = if provider == CliProvider::Codex { &["skills", "rules", "prompts"] } else { &["skills"] };
    for name in links {
        hash.update(name.as_bytes());
        let source_dir = source.join(name);
        let target = home.join(name);
        if !source_dir.is_dir() { retire_setting(&target, home)?; hash.update(b"absent"); continue; }
        let canonical = source_dir.canonicalize().map_err(unavailable)?;
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if is_link(&meta) && target.canonicalize().ok().as_ref() != Some(&canonical) { retire_setting(&target, home)?; }
        }
        if !target.exists() && link_directory(&canonical, &target).is_ok() { hash.update(b"linked"); }
        else if fs::symlink_metadata(&target).is_ok_and(|meta| is_link(&meta)) { hash.update(b"linked"); }
        else { reflect_tree(&canonical, &target, home, &mut hash)?; hash.update(b"copied"); }
    }
    if provider == CliProvider::Grok {
        let hooks = source.join("hooks"); hash.update(b"hooks:copy");
        if hooks.is_dir() { reflect_tree(&hooks, &home.join("hooks"), home, &mut hash)?; }
        else { retire_setting(&home.join("hooks"), home)?; hash.update(b"absent"); }
    }
    Ok(hex::encode(hash.finalize())[..16].into())
}
// Retain previous managed assets for recovery without leaving obsolete hooks
// enabled. This is a rename, never a recursive removal or a link traversal.
fn retire_setting(path: &Path, home: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_err() { return Ok(()); }
    let retired = home.join(".retired-settings"); private_dir(&retired)?;
    fs::rename(path, retired.join(uuid::Uuid::new_v4().simple().to_string())).map_err(unavailable)
}

pub fn begin_login(base: &Path, provider: CliProvider, id: &str, alive: impl Fn(&str) -> bool, source: &Path) -> Result<HomeLoginStatus, String> {
    let mut rt = runtime();
    prune(&mut rt, &base.canonicalize().map_err(invalid)?, &alive);
    let _profile = profile(base, provider, id)?;
    let key = key(base, provider, id)?;
    if in_use(&rt, &key, &alive) { return Err(ERR_HOME_IN_USE.into()); }
    if login_in_progress(&rt, &key) { return Err(super::ERR_LOGIN_ALREADY_RUNNING.into()); }
    let home = home_path(base, provider, id, true, true)?;
    let mut manifest = read_manifest(base)?;
    if !manifest.homes.iter().any(|h| h.status.provider == provider && h.status.profile_id == id) {
        manifest.homes.push(HomeRecord { status: AccountHomeStatus { provider, profile_id: id.into(), state: HomeState::Created, owner: "unverified".into(), generation: 0 }, created_at: now(), updated_at: now(), last_settings_digest: None });
        save_manifest(base, &manifest)?;
    }
    let record = manifest.homes.iter_mut().find(|h| h.status.provider == provider && h.status.profile_id == id).expect("inserted");
    let settings = reflect_settings(provider, source, &home)?;
    record.status.state = HomeState::AwaitingLogin; record.status.owner = "unverified".into();
    record.last_settings_digest = Some(settings); record.updated_at = now();
    let status = record.status.clone(); save_manifest(base, &manifest)?;
    let login_id = uuid::Uuid::new_v4().simple().to_string();
    let initial_auth = read_optional(&home.join("auth.json"))?.map(|bytes| digest(&bytes));
    let status = HomeLoginStatus { login_id: login_id.clone(), provider, profile_id: id.into(), state: "pending".into(), reason: None, home: status };
    rt.logins.insert(login_id, PendingHomeLogin { key, status: status.clone(), started: Instant::now(), session_id: None, cancelled: false, launched: false, initial_auth, candidate: None });
    Ok(status)
}
pub fn login_status(base: &Path, login_id: &str) -> Result<HomeLoginStatus, String> {
    let base = base.canonicalize().map_err(invalid)?;
    runtime().logins.get(login_id).filter(|p| p.key.base == base).map(|p| p.status.clone()).ok_or_else(|| super::ERR_LOGIN_SESSION_NOT_FOUND.into())
}
pub fn cancel_login(base: &Path, login_id: &str) -> bool {
    let Ok(base) = base.canonicalize() else { return false; };
    if let Some(pending) = runtime().logins.get_mut(login_id).filter(|p| p.key.base == base && p.status.state == "pending") { pending.cancelled = true; true } else { false }
}
/// A claimed login may only reattach to its own PTY, never start a second CLI.
pub fn claim_login(base: &Path, login_id: &str, session_id: &str) -> Result<(String, Vec<String>, &'static str, PathBuf), String> {
    let mut rt = runtime();
    let base = base.canonicalize().map_err(invalid)?;
    let pending = rt.logins.get_mut(login_id).filter(|p| p.key.base == base && p.status.state == "pending" && !p.cancelled).ok_or_else(|| super::ERR_LOGIN_SESSION_NOT_FOUND.to_string())?;
    if pending.session_id.as_deref().is_some_and(|id| id != session_id) { return Err(super::ERR_LOGIN_ALREADY_RUNNING.into()); }
    let home = home_path(&pending.key.base, pending.key.provider, &pending.key.profile_id, false, true)?;
    pending.session_id = Some(session_id.into());
    let (command, args, env_key) = staging::login_command(pending.key.provider);
    Ok((command.into(), args, env_key, home))
}
pub fn finish_login_launch(login_id: &str, success: bool) {
    if let Some(pending) = runtime().logins.get_mut(login_id) {
        pending.launched = success;
        if !success { pending.cancelled = true; }
    }
}
fn poll_login(base: &Path, login_id: &str, alive: impl Fn(&str) -> bool) -> Result<HomeLoginStatus, String> {
    let mut rt = runtime();
    let base = base.canonicalize().map_err(invalid)?;
    let pending = rt.logins.get_mut(login_id).filter(|p| p.key.base == base).ok_or_else(|| super::ERR_LOGIN_SESSION_NOT_FOUND.to_string())?;
    if pending.status.state != "pending" { return Ok(pending.status.clone()); }
    let fail = if pending.cancelled { Some(super::ERR_LOGIN_CANCELLED) }
        else if pending.started.elapsed() >= LOGIN_TIMEOUT { Some(super::ERR_LOGIN_TIMEOUT) } else { None };
    if let Some(reason) = fail { pending.status.state = "failed".into(); pending.status.reason = Some(reason.into()); return Ok(pending.status.clone()); }
    if pending.session_id.is_none() || !pending.launched { return Ok(pending.status.clone()); }
    let home = home_path(&base, pending.key.provider, &pending.key.profile_id, false, false)?;
    let stamp = read_optional(&home.join("auth.json"))?.map(|bytes| digest(&bytes));
    if stamp.is_none() || stamp == pending.initial_auth {
        pending.candidate = None;
        if pending.session_id.as_deref().is_some_and(|id| !alive(id)) {
            pending.status.state = "failed".into(); pending.status.reason = Some(super::ERR_LOGIN_CANCELLED.into());
        }
        return Ok(pending.status.clone());
    }
    if pending.candidate != stamp { pending.candidate = stamp; return Ok(pending.status.clone()); }
    let profile = profile(&base, pending.key.provider, &pending.key.profile_id)?;
    if let Err(reason) = check_owner(&home, pending.key.provider, &profile.identity_key) {
        pending.status.state = "failed".into(); pending.status.reason = Some(reason); return Ok(pending.status.clone());
    }
    let mut manifest = read_manifest(&base)?;
    let record = manifest.homes.iter_mut().find(|h| h.status.provider == pending.key.provider && h.status.profile_id == pending.key.profile_id).ok_or_else(|| ERR_HOME_NOT_READY.to_string())?;
    record.status.state = HomeState::Ready; record.status.owner = "matched".into(); record.status.generation += 1; record.updated_at = now();
    pending.status.home = record.status.clone(); save_manifest(&base, &manifest)?;
    pending.status.state = "ready".into();
    Ok(pending.status.clone())
}
pub fn spawn_login_watch(app: tauri::AppHandle, base: PathBuf, login_id: String) {
    use tauri::{Emitter, Manager};
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let poll_base = base.clone(); let poll_id = login_id.clone();
            let manager = app.state::<crate::AppState>().session_manager.clone();
            let polled = tauri::async_runtime::spawn_blocking(move || poll_login(&poll_base, &poll_id, |id| manager.is_alive(id))).await;
            let status = match polled {
                Ok(Ok(status)) => status,
                _ => {
                    let mut rt = runtime();
                    if let Some(pending) = rt.logins.get_mut(&login_id) { pending.status.state = "failed".into(); pending.status.reason = Some(ERR_HOME_ISOLATION_UNAVAILABLE.into()); }
                    drop(rt);
                    let _ = app.emit(super::login_watch::EVENT_LOGIN_FAILED, super::login_watch::LoginFailedPayload { login_id: login_id.clone(), code: ERR_HOME_ISOLATION_UNAVAILABLE.into() });
                    return;
                }
            };
            if status.state == "pending" { continue; }
            if status.state == "ready" {
                if let Ok(profile) = profile(&base, status.provider, &status.profile_id) {
                    let _ = app.emit(super::login_watch::EVENT_LOGIN_COMPLETED, super::login_watch::LoginCompletedPayload {
                        login_id: login_id.clone(), profile, updated_existing: true,
                        purpose: LoginPurpose::AccountHome { profile_id: status.profile_id },
                    });
                }
            } else { let _ = app.emit(super::login_watch::EVENT_LOGIN_FAILED, super::login_watch::LoginFailedPayload { login_id: login_id.clone(), code: status.reason.unwrap_or_else(|| ERR_HOME_NOT_READY.into()) }); }
            return;
        }
    });
}

#[cfg(test)]
#[path = "account_homes_tests.rs"]
mod account_homes_tests;
