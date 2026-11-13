//! Long-lived launch secrets stay in the OS store; only status is serializable.
use std::{fs, path::{Path, PathBuf}};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use super::{atomic::write_atomic, registry, snapshot, token_owner::{LaunchOwnerCheck, OrganizationCheck, OwnerCheck}, CliProvider,
    ERR_ACCOUNTS_UNAVAILABLE, ERR_LAUNCH_ACCOUNT_NOT_FOUND, ERR_LAUNCH_TOKEN_INVALID,
    ERR_LAUNCH_TOKEN_OWNER_MISMATCH, ERR_LAUNCH_TOKEN_RECORD_MISMATCH, ERR_REGISTRY_SAVE_FAILED, ERR_REMOVE_FAILED,
    ERR_SNAPSHOT_UNAVAILABLE};

const FILE: &str = "cli_account_launch_tokens.json";
const SERVICE: &str = "com.miyazaki.mycmux.cli-launch-token";

pub trait LaunchTokenStore {
    fn read(&self, profile_id: &str) -> Result<Option<String>, String>;
    fn write(&self, profile_id: &str, token: &str) -> Result<(), String>;
    fn delete(&self, profile_id: &str) -> Result<(), String>;
}

pub struct OsLaunchTokenStore { base: PathBuf }
impl OsLaunchTokenStore {
    pub fn new(base: &Path) -> Self { Self { base: base.to_path_buf() } }
}
impl LaunchTokenStore for OsLaunchTokenStore {
    fn read(&self, id: &str) -> Result<Option<String>, String> {
        validate_profile_id(id)?;
        platform::read(&self.base, id)
    }
    fn write(&self, id: &str, token: &str) -> Result<(), String> {
        validate_profile_id(id)?;
        platform::write(&self.base, id, token)
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        validate_profile_id(id)?;
        platform::delete(&self.base, id)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OwnerCheckStatus { Verified, OrgMatched, OrgShared, Unverified, Mismatch }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LaunchTokenStatus {
    pub profile_id: String,
    pub registered_at: String,
    pub expires_at: String,
    pub owner_check: OwnerCheckStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_check_status: Option<u16>,
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_method: Option<String>,
}

#[derive(Debug)]
pub enum SaveOutcome { Saved(LaunchTokenStatus), MismatchRecorded(LaunchTokenStatus) }

// Deliberately neither Debug nor Serialize: used only at the PTY boundary.
pub(crate) struct LaunchToken {
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub status: LaunchTokenStatus,
}

pub(crate) fn validate_profile_id(id: &str) -> Result<(), String> {
    snapshot::validate_snapshot_id(id).map_err(|_| ERR_LAUNCH_ACCOUNT_NOT_FOUND.to_string())
}

fn normalized_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    // Exact ASCII equivalent of ^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,512}$.
    let valid = token.strip_prefix("sk-ant-oat").is_some_and(|rest| {
        let bytes = rest.as_bytes();
        bytes.len() >= 23 && bytes.len() <= 515
            && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() && bytes[2] == b'-'
            && bytes[3..].iter().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
    });
    if valid { Ok(token) } else { Err(ERR_LAUNCH_TOKEN_INVALID.into()) }
}

pub fn status_all(base: &Path) -> Result<Vec<LaunchTokenStatus>, String> {
    let text = match fs::read_to_string(base.join(FILE)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err(ERR_ACCOUNTS_UNAVAILABLE.into()),
    };
    serde_json::from_str(&text).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.into())
}

fn save_status(base: &Path, records: &[LaunchTokenStatus]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(records).map_err(|_| ERR_REGISTRY_SAVE_FAILED.to_string())?;
    write_atomic(&base.join(FILE), &bytes).map_err(|_| ERR_REGISTRY_SAVE_FAILED.to_string())
}

fn check(
    base: &Path, profiles: &[super::CliAccountProfile], profile: &super::CliAccountProfile,
    result: LaunchOwnerCheck,
) -> (OwnerCheckStatus, Option<u16>, Option<String>) {
    let profile_status = match result.profile {
        OwnerCheck::Owner(owner) => return (
            if owner.account_uuid == profile.identity_key { OwnerCheckStatus::Verified } else { OwnerCheckStatus::Mismatch },
            None, Some("profile".into())),
        OwnerCheck::Rejected { status } => Some(status),
        OwnerCheck::RateLimited { .. } => Some(429),
        OwnerCheck::Unavailable => None,
    };
    match result.organization {
        Some(OrganizationCheck::Organization(org)) => {
            let Some(expected) = snapshot::claude_organization_uuid(base, &profile.id) else {
                return (OwnerCheckStatus::Unverified, None, Some("org".into()));
            };
            if org != expected { return (OwnerCheckStatus::Mismatch, None, Some("org".into())); }
            let shared = profiles.iter().filter(|other| other.provider == CliProvider::Claude)
                .filter(|other| snapshot::claude_organization_uuid(base, &other.id).as_deref() == Some(&org)).count() > 1;
            (if shared { OwnerCheckStatus::OrgShared } else { OwnerCheckStatus::OrgMatched }, None, Some("org".into()))
        }
        Some(OrganizationCheck::Unavailable { status }) => (OwnerCheckStatus::Unverified, status.or(profile_status), None),
        None => (OwnerCheckStatus::Unverified, profile_status, None),
    }
}

fn update_owner_check(
    record: &mut LaunchTokenStatus,
    (owner_check, owner_check_status, owner_method): (OwnerCheckStatus, Option<u16>, Option<String>),
) {
    // A failed or weaker lookup cannot erase a known mismatch for this token.
    let clears_mismatch = match record.owner_method.as_deref() {
        Some("profile") => owner_check == OwnerCheckStatus::Verified,
        _ => matches!(owner_check, OwnerCheckStatus::Verified | OwnerCheckStatus::OrgMatched),
    };
    let keep_mismatch = record.owner_check == OwnerCheckStatus::Mismatch
        && owner_check != OwnerCheckStatus::Mismatch && !clears_mismatch;
    if record.owner_check == OwnerCheckStatus::Mismatch && owner_check == OwnerCheckStatus::Mismatch {
        // Repeated mismatches keep the strongest evidence: profile > org.
        if record.owner_method.as_deref() != Some("profile") {
            record.owner_method = owner_method;
        }
    } else if !keep_mismatch {
        record.owner_check = owner_check;
        record.owner_method = owner_method;
    }
    record.owner_check_status = owner_check_status;
    record.owner_checked_at = Some(Utc::now().to_rfc3339());
}

fn token_fingerprint(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))[..10].into()
}

/// The caller supplies the owner lookup; tests never contact the provider.
pub fn save(
    base: &Path, secrets: &dyn LaunchTokenStore, profile_id: &str, token: &str,
    check_owner: impl FnOnce(&str) -> LaunchOwnerCheck,
) -> Result<LaunchTokenStatus, String> {
    match save_with_outcome(base, secrets, profile_id, token, check_owner)? {
        SaveOutcome::Saved(status) => Ok(status),
        SaveOutcome::MismatchRecorded(_) => Err(ERR_LAUNCH_TOKEN_OWNER_MISMATCH.into()),
    }
}

/// Report every persisted status, including a mismatch that still rejects launch.
pub fn save_with_outcome(
    base: &Path, secrets: &dyn LaunchTokenStore, profile_id: &str, token: &str,
    check_owner: impl FnOnce(&str) -> LaunchOwnerCheck,
) -> Result<SaveOutcome, String> {
    save_with_status_writer(base, secrets, profile_id, token, check_owner, save_status)
}

fn save_with_status_writer(
    base: &Path, secrets: &dyn LaunchTokenStore, profile_id: &str, token: &str,
    check_owner: impl FnOnce(&str) -> LaunchOwnerCheck,
    persist_status: impl FnOnce(&Path, &[LaunchTokenStatus]) -> Result<(), String>,
) -> Result<SaveOutcome, String> {
    let _guard = super::mutation_guard()?;
    validate_profile_id(profile_id)?;
    let registry = registry::load(base).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let profile = registry.profiles.iter()
        .find(|profile| profile.id == profile_id && profile.provider == CliProvider::Claude)
        .ok_or_else(|| ERR_LAUNCH_ACCOUNT_NOT_FOUND.to_string())?;
    let token = normalized_token(token)?;
    let mut records = status_all(base)?;
    let previous_token = secrets.read(profile_id).map_err(|_| ERR_REGISTRY_SAVE_FAILED.to_string())?;
    let fingerprint = token_fingerprint(token);
    let same_token = records.iter().any(|record| record.profile_id == profile_id && record.fingerprint == fingerprint);
    let needs_write = previous_token.as_deref() != Some(token);
    let checked = check(base, &registry.profiles, profile, check_owner(token));
    let persist_registration = |records: &[LaunchTokenStatus], write_secret: bool| {
        if write_secret { secrets.write(profile_id, token).map_err(|_| ERR_REGISTRY_SAVE_FAILED.to_string())?; }
        if let Err(error) = persist_status(base, records) {
            if write_secret {
                // Preserve the original save error even when restoring the secret fails.
                let _ = match previous_token.as_deref() {
                    Some(previous) => secrets.write(profile_id, previous),
                    None => secrets.delete(profile_id),
                };
            }
            return Err(error);
        }
        Ok(())
    };
    if same_token {
        if let Some(record) = records.iter_mut().find(|record| record.profile_id == profile_id && record.fingerprint == fingerprint) {
            update_owner_check(record, checked);
            let result = record.clone();
            let mismatch = result.owner_check == OwnerCheckStatus::Mismatch;
            persist_registration(&records, needs_write && !mismatch)?;
            return if mismatch {
                Ok(SaveOutcome::MismatchRecorded(result))
            } else { Ok(SaveOutcome::Saved(result)) };
        }
    }
    let (owner_check, owner_check_status, owner_method) = checked;
    if owner_check == OwnerCheckStatus::Mismatch { return Err(ERR_LAUNCH_TOKEN_OWNER_MISMATCH.into()); }
    let registered_at = Utc::now();
    let record = LaunchTokenStatus {
        profile_id: profile_id.into(), registered_at: registered_at.to_rfc3339(),
        expires_at: (registered_at + Duration::days(365)).to_rfc3339(),
        owner_check, owner_check_status, owner_method, owner_checked_at: Some(registered_at.to_rfc3339()),
        fingerprint,
    };
    records.retain(|record| record.profile_id != profile_id);
    records.push(record.clone());
    persist_registration(&records, needs_write)?;
    Ok(SaveOutcome::Saved(record))
}

pub fn recheck(
    base: &Path, secrets: &dyn LaunchTokenStore, profile_id: &str,
    check_owner: impl FnOnce(&str) -> LaunchOwnerCheck,
) -> Result<LaunchTokenStatus, String> {
    let _guard = super::mutation_guard()?;
    validate_profile_id(profile_id)?;
    let registry = registry::load(base).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let profile = registry.profiles.iter()
        .find(|profile| profile.id == profile_id && profile.provider == CliProvider::Claude)
        .ok_or_else(|| ERR_LAUNCH_ACCOUNT_NOT_FOUND.to_string())?;
    let mut records = status_all(base)?;
    let record = records.iter_mut().find(|record| record.profile_id == profile_id)
        .ok_or_else(|| super::ERR_LAUNCH_TOKEN_MISSING.to_string())?;
    let token = load_token(secrets, profile_id)?.ok_or_else(|| super::ERR_LAUNCH_TOKEN_MISSING.to_string())?;
    if token_fingerprint(&token) != record.fingerprint { return Err(ERR_LAUNCH_TOKEN_RECORD_MISMATCH.into()); }
    update_owner_check(record, check(base, &registry.profiles, profile, check_owner(&token)));
    let result = record.clone();
    save_status(base, &records)?;
    Ok(result)
}

pub fn load_token(secrets: &dyn LaunchTokenStore, profile_id: &str) -> Result<Option<String>, String> {
    validate_profile_id(profile_id)?;
    secrets.read(profile_id).map_err(|_| ERR_SNAPSHOT_UNAVAILABLE.into())
}

pub(crate) fn load_for_launch(base: &Path, profile_id: &str) -> Result<Option<LaunchToken>, String> {
    load_for_launch_with_store(base, &OsLaunchTokenStore::new(base), profile_id)
}

fn load_for_launch_with_store(base: &Path, secrets: &dyn LaunchTokenStore, profile_id: &str) -> Result<Option<LaunchToken>, String> {
    let _guard = super::mutation_guard()?;
    validate_profile_id(profile_id)?;
    let Some(record) = status_all(base)?.into_iter().find(|record| record.profile_id == profile_id) else { return Ok(None) };
    let token = load_token(secrets, profile_id)?;
    if token.as_deref().is_some_and(|token| token_fingerprint(token) != record.fingerprint) {
        return Err(ERR_LAUNCH_TOKEN_RECORD_MISMATCH.into());
    }
    if record.owner_check == OwnerCheckStatus::Mismatch { return Err(ERR_LAUNCH_TOKEN_OWNER_MISMATCH.into()); }
    let expires_at = DateTime::parse_from_rfc3339(&record.expires_at)
        .map_err(|_| ERR_SNAPSHOT_UNAVAILABLE.to_string())?.with_timezone(&Utc);
    Ok(token.map(|token| LaunchToken { token, expires_at, status: record }))
}

pub fn remove(base: &Path, secrets: &dyn LaunchTokenStore, profile_id: &str) -> Result<(), String> {
    let _guard = super::mutation_guard()?;
    remove_locked(base, secrets, profile_id)
}

/// Also used by remove_resolved while it already owns mutation_guard.
pub(super) fn remove_locked(base: &Path, secrets: &dyn LaunchTokenStore, profile_id: &str) -> Result<(), String> {
    validate_profile_id(profile_id)?;
    let mut records = status_all(base)?;
    secrets.delete(profile_id).map_err(|_| ERR_REMOVE_FAILED.to_string())?;
    let before = records.len();
    records.retain(|record| record.profile_id != profile_id);
    if records.len() != before { save_status(base, &records)?; }
    Ok(())
}

// ponytail: these platform adapters copy commands/jev_secrets.rs. Extract a
// shared OS-secret adapter with read/write/delete when both callers can migrate
// together; keep their service/account namespaces and profile base directories.
#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, io::Write, ptr};
    #[repr(C)]
    struct Blob { size: u32, data: *mut u8 }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(input: *const Blob, description: *const u16, entropy: *const Blob,
            reserved: *mut c_void, prompt: *const c_void, flags: u32, output: *mut Blob) -> i32;
        fn CryptUnprotectData(input: *const Blob, description: *mut *mut u16, entropy: *const Blob,
            reserved: *mut c_void, prompt: *const c_void, flags: u32, output: *mut Blob) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" { fn LocalFree(memory: *mut c_void) -> *mut c_void; }
    fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
        let input = Blob { size: bytes.len().try_into().map_err(|_| "key_storage")?, data: bytes.as_ptr() as *mut u8 };
        let mut output = Blob { size: 0, data: ptr::null_mut() };
        // CRYPTPROTECT_UI_FORBIDDEN; default protection binds to the current OS user.
        let ok = unsafe {
            if decrypt { CryptUnprotectData(&input, ptr::null_mut(), ptr::null(), ptr::null_mut(), ptr::null(), 1, &mut output) }
            else { CryptProtectData(&input, ptr::null(), ptr::null(), ptr::null_mut(), ptr::null(), 1, &mut output) }
        };
        if ok == 0 { return Err("key_storage".into()); }
        let result = if output.size == 0 { vec![] } else {
            unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() }
        };
        unsafe { LocalFree(output.data.cast()); }
        Ok(result)
    }
    fn dir(base: &Path) -> PathBuf { base.join("cli_account_launch_tokens") }
    pub fn read(base: &Path, id: &str) -> Result<Option<String>, String> {
        let bytes = match fs::read(dir(base).join(format!("{id}.bin"))) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("key_storage".into()),
        };
        String::from_utf8(protect(&bytes, true)?).map(Some).map_err(|_| "key_storage".into())
    }
    pub fn write(base: &Path, id: &str, token: &str) -> Result<(), String> {
        let dir = dir(base);
        fs::create_dir_all(&dir).map_err(|_| "key_storage")?;
        let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(|_| "key_storage")?;
        file.write_all(&protect(token.as_bytes(), false)?).map_err(|_| "key_storage")?;
        file.as_file().sync_all().map_err(|_| "key_storage")?;
        file.persist(dir.join(format!("{id}.bin"))).map_err(|_| "key_storage")?;
        Ok(())
    }
    pub fn delete(base: &Path, id: &str) -> Result<(), String> {
        match fs::remove_file(dir(base).join(format!("{id}.bin"))) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("key_storage".into()),
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{ffi::c_void, ptr};
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainFindGenericPassword(keychain: *const c_void, service_len: u32, service: *const u8,
            account_len: u32, account: *const u8, length: *mut u32, data: *mut *mut c_void, item: *mut *mut c_void) -> i32;
        fn SecKeychainAddGenericPassword(keychain: *const c_void, service_len: u32, service: *const u8,
            account_len: u32, account: *const u8, length: u32, data: *const c_void, item: *mut *mut c_void) -> i32;
        fn SecKeychainItemModifyAttributesAndData(item: *const c_void, attributes: *const c_void, length: u32, data: *const c_void) -> i32;
        fn SecKeychainItemFreeContent(attributes: *const c_void, data: *const c_void) -> i32;
        fn SecKeychainItemDelete(item: *const c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" { fn CFRelease(value: *const c_void); }
    pub fn read(_base: &Path, id: &str) -> Result<Option<String>, String> {
        let mut length = 0;
        let mut data = ptr::null_mut();
        let status = unsafe { SecKeychainFindGenericPassword(ptr::null(), SERVICE.len() as u32, SERVICE.as_ptr(),
            id.len() as u32, id.as_ptr(), &mut length, &mut data, ptr::null_mut()) };
        if status == -25300 { return Ok(None); }
        if status != 0 { return Err("key_storage".into()); }
        let bytes = if length == 0 { vec![] } else { unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize).to_vec() } };
        unsafe { SecKeychainItemFreeContent(ptr::null(), data); }
        String::from_utf8(bytes).map(Some).map_err(|_| "key_storage".into())
    }
    pub fn write(_base: &Path, id: &str, token: &str) -> Result<(), String> {
        let mut item = ptr::null_mut();
        let found = unsafe { SecKeychainFindGenericPassword(ptr::null(), SERVICE.len() as u32, SERVICE.as_ptr(),
            id.len() as u32, id.as_ptr(), ptr::null_mut(), ptr::null_mut(), &mut item) };
        let status = unsafe {
            if found == 0 {
                let status = SecKeychainItemModifyAttributesAndData(item, ptr::null(), token.len() as u32, token.as_ptr().cast());
                CFRelease(item);
                status
            } else if found == -25300 {
                SecKeychainAddGenericPassword(ptr::null(), SERVICE.len() as u32, SERVICE.as_ptr(), id.len() as u32,
                    id.as_ptr(), token.len() as u32, token.as_ptr().cast(), ptr::null_mut())
            } else { found }
        };
        if status == 0 { Ok(()) } else { Err("key_storage".into()) }
    }
    pub fn delete(_base: &Path, id: &str) -> Result<(), String> {
        let mut item = ptr::null_mut();
        let found = unsafe { SecKeychainFindGenericPassword(ptr::null(), SERVICE.len() as u32, SERVICE.as_ptr(),
            id.len() as u32, id.as_ptr(), ptr::null_mut(), ptr::null_mut(), &mut item) };
        if found == -25300 { return Ok(()); }
        if found != 0 { return Err("key_storage".into()); }
        let status = unsafe { let status = SecKeychainItemDelete(item); CFRelease(item); status };
        if status == 0 || status == -25300 { Ok(()) } else { Err("key_storage".into()) }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::*;
    use std::{io::Write, process::{Command, Stdio}};
    pub fn read(_base: &Path, id: &str) -> Result<Option<String>, String> {
        let output = Command::new("secret-tool").args(["lookup", "application", SERVICE, "account", id])
            .stderr(Stdio::null()).output().map_err(|_| "key_storage")?;
        if output.status.code() == Some(1) { return Ok(None); }
        if !output.status.success() { return Err("key_storage".into()); }
        String::from_utf8(output.stdout).map(|s| Some(s.trim_end().to_string())).map_err(|_| "key_storage".into())
    }
    pub fn write(_base: &Path, id: &str, token: &str) -> Result<(), String> {
        let mut child = Command::new("secret-tool").args(["store", "--label=mycmux Claude launch token", "application", SERVICE, "account", id])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "key_storage")?;
        child.stdin.take().ok_or("key_storage")?.write_all(token.as_bytes()).map_err(|_| "key_storage")?;
        if child.wait().map_err(|_| "key_storage")?.success() { Ok(()) } else { Err("key_storage".into()) }
    }
    pub fn delete(_base: &Path, id: &str) -> Result<(), String> {
        let status = Command::new("secret-tool").args(["clear", "application", SERVICE, "account", id])
            .stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| "key_storage")?;
        if status.success() || status.code() == Some(1) { Ok(()) } else { Err("key_storage".into()) }
    }
}

#[cfg(test)]
#[path = "launch_tokens_tests.rs"]
mod tests;
