//! Read-only record provenance. Account record links are never followed; global readers keep their legacy policy.
use std::{fs, path::{Component, Path, PathBuf}, sync::{Arc, OnceLock, Weak}};
use crate::{cli_accounts::{account_homes::{self, AccountLaunchContext}, CliProvider}, pty::manager::SessionManager};

pub const AMBIGUOUS: &str = "ambiguousSource";
pub const HOME_SESSION_UNSUPPORTED: &str = "cli_account.error.home_session_unsupported";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin { Global, AccountHome { provider: CliProvider, profile_id: String } }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordRoot { pub origin: Origin, pub path: PathBuf }
struct Registration { base: PathBuf, manager: Weak<SessionManager> }
static REGISTRATION: OnceLock<Registration> = OnceLock::new();

pub fn is_registered() -> bool { REGISTRATION.get().is_some() }
pub fn register(base: PathBuf, manager: &Arc<SessionManager>) {
    let _ = REGISTRATION.set(Registration { base, manager: Arc::downgrade(manager) });
}
pub fn provider(kind: &str) -> Option<CliProvider> {
    match kind { "codex" => Some(CliProvider::Codex), "grok" => Some(CliProvider::Grok), _ => None }
}
fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).map_or(false, |meta| {
        #[cfg(windows)] { use std::os::windows::fs::MetadataExt; meta.file_attributes() & 0x400 != 0 }
        #[cfg(not(windows))] { meta.file_type().is_symlink() }
    })
}
/// Only account-owned components are checked. Ancestors of the container are
/// allowed to be linked, matching 2A's canonical-base boundary.
fn unlinked_from(container: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(container) else { return false; };
    let mut current = container.to_path_buf();
    if is_link(&current) { return false; }
    for part in relative.components() {
        if matches!(part, Component::ParentDir) { return false; }
        current.push(part.as_os_str());
        if is_link(&current) { return false; }
    }
    true
}
/// Single reader gate: global paths perform no additional link checks, while
/// account records (including mirrors) are strict only from their container.
pub fn record_path_allowed(path: &Path) -> bool {
    account_record_boundary(path).map_or(true, |container| unlinked_from(container, path))
}
fn roots_at_home(provider: CliProvider, home: &Path, origin: Origin) -> Vec<RecordRoot> {
    let mut roots = vec![RecordRoot { origin: origin.clone(), path: home.join("sessions") }];
    if provider == CliProvider::Codex { roots.push(RecordRoot { origin, path: home.join("archived_sessions") }); }
    roots
}
pub fn globals(provider: CliProvider) -> Vec<RecordRoot> {
    let root = match provider { CliProvider::Codex => crate::ailog::codex_root(), CliProvider::Grok => crate::ailog::grok_root(), _ => None };
    root.and_then(|root| root.parent().map(Path::to_path_buf)).map(|home| roots_at_home(provider, &home, Origin::Global)).unwrap_or_default()
}
/// Injectable catalog for fixture-only tests. Registration is deliberately optional.
pub(crate) fn catalog_at(base: Option<&Path>, provider: CliProvider, mut global: Vec<RecordRoot>) -> Vec<RecordRoot> {
    let Some(base) = base else { return global; };
    let Ok(name) = account_homes::provider_name(provider) else { return global; };
    let container = base.join("cli_account_homes");
    let parent = container.join(name);
    if !unlinked_from(&container, &parent) { return global; }
    let Ok(boundary) = container.canonicalize() else { return global; };
    let Ok(entries) = fs::read_dir(&parent) else { return global; };
    let mut homes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else { continue; };
        if !account_homes::valid_record_profile_id(&id) || !unlinked_from(&container, &path) || !path.is_dir() { continue; }
        let Ok(canonical) = path.canonicalize() else { continue; };
        if !canonical.starts_with(&boundary) || canonical.parent() != parent.canonicalize().ok().as_deref() { continue; }
        homes.extend(roots_at_home(provider, &canonical, Origin::AccountHome { provider, profile_id: id }));
    }
    homes.sort_by(|a,b| a.path.cmp(&b.path));
    global.extend(homes);
    let mut seen = std::collections::HashSet::new();
    global.retain(|root| seen.insert(root.path.clone()));
    global
}
pub fn all(provider: CliProvider) -> Vec<RecordRoot> {
    catalog_at(REGISTRATION.get().map(|r| r.base.as_path()), provider, globals(provider))
}
pub fn accounts(provider: CliProvider) -> Vec<RecordRoot> {
    catalog_at(REGISTRATION.get().map(|r| r.base.as_path()), provider, Vec::new())
}
pub(crate) fn select_session_roots(provider: CliProvider, global: Vec<RecordRoot>, alive: bool,
    context: impl FnOnce() -> Result<Option<AccountLaunchContext>, String>) -> Result<Vec<RecordRoot>, String> {
    if !alive { return Ok(global); }
    match context()? {
        Some(context) if context.provider == provider => Ok(roots_at_home(provider, context.home(), Origin::AccountHome { provider, profile_id: context.profile_id.clone() })),
        Some(_) => Err(account_homes::ERR_HOME_PATH_INVALID.into()),
        None => Ok(global),
    }
}
pub fn for_session(provider: CliProvider, session_id: &str) -> Result<Vec<RecordRoot>, String> {
    let global = globals(provider);
    let Some(registration) = REGISTRATION.get() else { return Ok(global); };
    let alive = registration.manager.upgrade().is_some_and(|m| m.is_alive(session_id));
    select_session_roots(provider, global, alive, || account_homes::record_context_for_session(&registration.base, session_id))
}
/// Current PTYs normally use the stable tab ID; resolve a unique legacy composite too.
pub fn for_tab(provider: CliProvider, tab_id: &str) -> Result<Vec<RecordRoot>, String> {
    if let Some(manager) = REGISTRATION.get().and_then(|r| r.manager.upgrade()) {
        if !manager.is_alive(tab_id) {
            let suffix = format!("-{tab_id}");
            let mut matches = manager.iter_pids().into_iter().map(|(id,_)| id)
                .filter(|id| id.ends_with(&suffix) && manager.is_alive(id));
            if let Some(id) = matches.next() {
                if matches.next().is_some() { return Err(AMBIGUOUS.into()); }
                return for_session(provider, &id);
            }
        }
    }
    for_session(provider, tab_id)
}
pub fn collect_files(root: &Path, out: &mut Vec<PathBuf>, file_name: Option<&str>) {
    if !record_path_allowed(root) { return; }
    let Ok(entries) = fs::read_dir(root) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if !record_path_allowed(&path) { continue; }
        let Ok(ty) = entry.file_type() else { continue; };
        if ty.is_dir() { collect_files(&path, out, file_name); }
        else if ty.is_file() && path.extension().is_some_and(|ext| ext == "jsonl")
            && file_name.map_or(true, |name| path.file_name().is_some_and(|actual| actual == name)) { out.push(path); }
    }
}
pub fn find_unique(roots: &[RecordRoot], provider: CliProvider, id: &str) -> Result<Option<(RecordRoot, PathBuf)>, String> {
    find_unique_with_global(roots, provider, id, |root| {
        let mut files = Vec::new();
        collect_files(root, &mut files, (provider == CliProvider::Grok).then_some("updates.jsonl"));
        files
    }, |_, _| false)
}
/// Keep a reader's original global traversal (e.g. LiveBrief's glob), while
/// selecting the strict account walker here rather than in individual readers.
/// Different origins are ambiguous; within one origin retain the reader's
/// selection rule (first traversal match unless it supplies a preference).
pub(crate) fn find_unique_with_global(roots: &[RecordRoot], provider: CliProvider, id: &str,
    mut global_files: impl FnMut(&Path) -> Vec<PathBuf>,
    mut prefer: impl FnMut(&Path, &Path) -> bool) -> Result<Option<(RecordRoot, PathBuf)>, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'-'|b'_')) { return Ok(None); }
    let mut found: Option<(RecordRoot, PathBuf)> = None;
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let files = match &root.origin {
            Origin::Global => global_files(&root.path),
            Origin::AccountHome {..} => {
                let mut files = Vec::new();
                collect_files(&root.path, &mut files, (provider == CliProvider::Grok).then_some("updates.jsonl"));
                files
            }
        };
        for path in files {
            let matches = if provider == CliProvider::Grok { path.parent().and_then(Path::file_name).is_some_and(|name| name == id) }
                else { path.file_name().and_then(|s| s.to_str()).is_some_and(|name| name.ends_with(&format!("-{id}.jsonl")) || name == format!("{id}.jsonl")) };
            if !matches { continue; }
            if let Some((previous, _)) = &found {
                if previous.origin != root.origin { return Err(AMBIGUOUS.into()); }
            }
            if !seen.insert(path.clone()) { continue; }
            if found.as_ref().map_or(true, |(_, previous)| prefer(&path, previous)) {
                found = Some((root.clone(), path));
            }
        }
    }
    Ok(found)
}
/// Path provenance also works after the original has disappeared (mirror recovery).
pub fn origin_for_root(kind: &str, root: &Path) -> Origin {
    let parsed = (|| {
        let provider = provider(kind)?;
        let home = root.parent()?;
        let id = home.file_name()?.to_str()?;
        let parent = home.parent()?;
        if !account_homes::valid_record_profile_id(id) || parent.file_name()?.to_str()? != kind
            || parent.parent()?.file_name()?.to_str()? != "cli_account_homes" { return None; }
        Some(Origin::AccountHome { provider, profile_id: id.to_owned() })
    })();
    parsed.unwrap_or(Origin::Global)
}
/// Recognize live and mirrored account records without probing credentials or the filesystem.
pub fn account_record_path(path: &Path) -> bool { account_record_boundary(path).is_some() }
fn account_record_boundary(path: &Path) -> Option<&Path> {
    path.ancestors().find_map(|root| {
        if !root.file_name().is_some_and(|name| name == "sessions" || name == "archived_sessions") { return None; }
        let home = root.parent()?;
        let id = home.file_name()?.to_str()?;
        let provider = home.parent()?;
        let container = provider.parent()?;
        (account_homes::valid_record_profile_id(id)
            && provider.file_name().and_then(|name| name.to_str()).and_then(self::provider).is_some()
            && container.file_name().is_some_and(|name| name == "cli_account_homes" || name == "accounts")).then_some(container)
    })
}
pub fn mirror_root(kind: &str, source_root: &Path, tier: &Path) -> PathBuf {
    match origin_for_root(kind, source_root) {
        Origin::AccountHome { profile_id, .. } => tier.join("accounts").join(kind).join(profile_id)
            .join(source_root.file_name().unwrap_or_default()),
        Origin::Global if kind == "codex" && source_root.file_name().is_some_and(|name| name == "archived_sessions") => tier.join("archived_sessions").join(kind),
        Origin::Global => tier.join(kind),
    }
}
pub fn reject_home_session(roots: &[RecordRoot], provider: CliProvider, id: &str) -> Result<(), String> {
    // Reject before an operation can choose a global fallback, including ID collisions.
    for root in roots.iter().filter(|root| matches!(root.origin, Origin::AccountHome {..})) {
        if !matches!(find_unique(std::slice::from_ref(root), provider, id), Ok(None)) { return Err(HOME_SESSION_UNSUPPORTED.into()); }
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_home_roots_tests.rs"]
mod tests;

#[cfg(all(test, unix))]
#[path = "agent_home_roots_link_tests.rs"]
pub(crate) mod link_tests;
