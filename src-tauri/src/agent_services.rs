//! File-only mirror of the launcher command resolution. Never starts a shell.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// Contract-tested against LAUNCHABLE_AGENTS, including targets sharing a CLI.
const SERVICE_RULES: &[(&str, &str)] = &[
    ("claude", "claude"),
    ("codex", "codex"),
    ("claude-codex", "claude-codex"),
    ("grok", "grok"),
    ("agy", "agy"),
    ("hermes", "hermes"),
    ("omp", "omp"),
    ("cursor", "cursor-agent"),
];

#[derive(Clone, Copy)]
enum Platform { Windows, Posix }

struct SearchEnv {
    home: Option<PathBuf>,
    appdata: Option<PathBuf>,
    localappdata: Option<PathBuf>,
    paths: Vec<PathBuf>,
    pathext: Vec<String>,
}

fn at(root: &Option<PathBuf>, parts: &[&str], available: &impl Fn(&Path) -> bool) -> bool {
    root.as_ref().is_some_and(|root| {
        let mut path = root.clone();
        for part in parts { path.push(part); }
        available(&path)
    })
}

fn on_path(command: &str, platform: Platform, env: &SearchEnv, available: &impl Fn(&Path) -> bool) -> bool {
    env.paths.iter().any(|dir| match platform {
        Platform::Posix => available(&dir.join(command)),
        Platform::Windows => {
            // PowerShell also resolves ExternalScript (.ps1) outside PATHEXT.
            env.pathext.iter().chain(std::iter::once(&".ps1".to_string()))
                .any(|ext| available(&dir.join(format!("{command}{ext}"))))
        }
    })
}

fn detect_with(platform: Platform, env: &SearchEnv, available: impl Fn(&Path) -> bool) -> BTreeMap<String, bool> {
    SERVICE_RULES.iter().map(|&(target, command)| {
        let shim = format!("{command}.cmd");
        let found = match platform {
            Platform::Windows => match target {
                "claude" | "claude-codex" => at(&env.home, &["bin", &shim], &available),
                "codex" => at(&env.appdata, &["npm", &shim], &available),
                "hermes" => at(&env.localappdata, &["hermes", "bin", "hermes.exe"], &available),
                "omp" => at(&env.localappdata, &["omp", "omp.exe"], &available),
                "cursor" => at(&env.localappdata, &["cursor-agent", &shim], &available)
                    || on_path(command, platform, env, &available),
                _ => on_path(command, platform, env, &available),
            },
            // launcher.sh currently uses this literal path even on POSIX.
            Platform::Posix if target == "hermes" =>
                at(&env.home, &["AppData", "Local", "hermes", "bin", "hermes.exe"], &available),
            Platform::Posix => on_path(command, platform, env, &available)
                || (target == "cursor" && at(&env.home, &[".local", "bin", "cursor-agent"], &available)),
        };
        (target.to_string(), found)
    }).collect()
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else { return false };
    if !metadata.is_file() { return false; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    { true }
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AgentServiceDetectionReply {
    WaitingForPath,
    Success { installed: BTreeMap<String, bool> },
}

// A missing confirmed macOS PATH is retryable readiness, not a failed probe.
// Inject the platform and PATH sources so Windows can test the cold-start order.
fn detection_path(
    macos: bool,
    confirmed: Option<&str>,
    inherited: impl FnOnce() -> Result<String, String>,
) -> Result<Option<String>, String> {
    if macos { Ok(confirmed.map(str::to_string)) } else { inherited().map(Some) }
}

fn detect_installed() -> Result<AgentServiceDetectionReply, String> {
    // Windows inherits the pane PATH. Import-MycmuxUserEnvIfMissing only imports
    // FUGU_API_KEY, not PATH or any executable location.
    #[cfg(target_os = "macos")]
    let confirmed = crate::commands::shell::cached_login_shell_path();
    #[cfg(not(target_os = "macos"))]
    let confirmed = None;
    let Some(path) = detection_path(cfg!(target_os = "macos"), confirmed,
        || std::env::var("PATH").map_err(|error| error.to_string()))? else {
        return Ok(AgentServiceDetectionReply::WaitingForPath);
    };
    let platform = if cfg!(windows) { Platform::Windows } else { Platform::Posix };
    let paths = if cfg!(windows) {
        path.split(';').filter(|p| !p.trim().is_empty())
            .map(|p| PathBuf::from(p.trim_matches('"'))).collect()
    } else {
        path.split(':').map(|p| PathBuf::from(if p.is_empty() { "." } else { p })).collect()
    };
    let env = SearchEnv {
        home: dirs::home_dir(),
        appdata: std::env::var_os("APPDATA").map(PathBuf::from),
        localappdata: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        paths,
        pathext: std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';').filter(|s| !s.is_empty()).map(|s| s.to_ascii_lowercase()).collect(),
    };
    Ok(AgentServiceDetectionReply::Success { installed: detect_with(platform, &env, executable) })
}

#[tauri::command]
pub async fn detect_agent_services() -> Result<AgentServiceDetectionReply, String> {
    tauri::async_runtime::spawn_blocking(detect_installed).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn macos_cold_start_waits_without_using_the_inherited_path() {
        assert_eq!(detection_path(true, None, || panic!("must not use launchd PATH")), Ok(None));
        assert_eq!(serde_json::to_value(AgentServiceDetectionReply::WaitingForPath).unwrap(),
            serde_json::json!({ "status": "waiting-for-path" }));
    }

    #[test]
    fn macos_delayed_readiness_uses_only_the_confirmed_login_path() {
        assert_eq!(detection_path(true, None, || panic!("not ready")), Ok(None));
        assert_eq!(detection_path(true, Some("/opt/homebrew/bin:/usr/bin"), || panic!("already ready")),
            Ok(Some("/opt/homebrew/bin:/usr/bin".into())));
        let installed = BTreeMap::from([("claude".to_string(), true)]);
        assert_eq!(serde_json::to_value(AgentServiceDetectionReply::Success { installed }).unwrap(),
            serde_json::json!({ "status": "success", "installed": { "claude": true } }));
    }

    #[test]
    fn windows_and_linux_do_not_wait_for_a_login_path() {
        assert_eq!(detection_path(false, None, || Ok("process-path".into())), Ok(Some("process-path".into())));
        assert_eq!(detection_path(false, Some("ignored"), || Ok("process-path".into())), Ok(Some("process-path".into())));
        assert_eq!(detection_path(false, None, || Err("missing PATH".into())), Err("missing PATH".into()));
    }

    fn env() -> SearchEnv {
        SearchEnv {
            home: Some(PathBuf::from("/home/user")), appdata: Some(PathBuf::from("/roaming")),
            localappdata: Some(PathBuf::from("/local")), paths: vec![PathBuf::from("/tools")],
            pathext: vec![".exe".into(), ".cmd".into(), ".custom".into()],
        }
    }

    #[test]
    fn windows_fixed_paths_match_launcher_not_path_aliases() {
        let env = env();
        let files: HashSet<_> = [
            env.home.as_ref().unwrap().join("bin/claude.cmd"),
            env.home.as_ref().unwrap().join("bin/claude-codex.cmd"),
            env.appdata.as_ref().unwrap().join("npm/codex.cmd"),
            env.localappdata.as_ref().unwrap().join("hermes/bin/hermes.exe"),
            env.localappdata.as_ref().unwrap().join("omp/omp.exe"),
            env.localappdata.as_ref().unwrap().join("cursor-agent/cursor-agent.cmd"),
            PathBuf::from("/tools/grok.ps1"), PathBuf::from("/tools/agy.custom"),
        ].into_iter().collect();
        assert!(detect_with(Platform::Windows, &env, |p| files.contains(p)).values().all(|v| *v));
        let aliases: HashSet<_> = ["claude", "claude-codex", "codex", "hermes", "omp"]
            .map(|name| PathBuf::from(format!("/tools/{name}.exe"))).into_iter().collect();
        assert!(detect_with(Platform::Windows, &env, |p| aliases.contains(p)).values().all(|v| !*v));
    }

    #[test]
    fn windows_path_extensions_and_cursor_fallback() {
        let env = env();
        let files: HashSet<_> = ["grok.cmd", "agy.exe", "cursor-agent.custom"].map(|name| PathBuf::from("/tools").join(name)).into_iter().collect();
        let found = detect_with(Platform::Windows, &env, |p| files.contains(p));
        for target in ["grok", "agy", "cursor"] { assert!(found[target]); }
        assert!(detect_with(Platform::Windows, &env, |_| false).values().all(|v| !*v));
        assert!(detect_with(Platform::Windows, &env, |p| p == Path::new("/tools/agy")).values().all(|v| !*v));
    }

    #[test]
    fn posix_uses_executable_path_entries_and_literal_hermes_path() {
        let env = env();
        let mut files: HashSet<_> = SERVICE_RULES.iter().filter(|(target, _)| *target != "hermes")
            .map(|(_, command)| PathBuf::from("/tools").join(command)).collect();
        files.insert(env.home.as_ref().unwrap().join("AppData/Local/hermes/bin/hermes.exe"));
        assert!(detect_with(Platform::Posix, &env, |p| files.contains(p)).values().all(|v| *v));
        assert!(detect_with(Platform::Posix, &env, |_| false).values().all(|v| !*v));
        assert!(!detect_with(Platform::Posix, &env, |p| p == Path::new("/tools/hermes"))["hermes"]);
        assert!(!detect_with(Platform::Posix, &env, |p| p == Path::new("/tools/grok.cmd"))["grok"]);
    }

    #[test]
    fn posix_cursor_falls_back_to_user_local_bin_only_when_executable() {
        let env = env();
        let fallback = env.home.as_ref().unwrap().join(".local/bin/cursor-agent");
        assert!(detect_with(Platform::Posix, &env, |p| p == fallback)["cursor"]);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("not-executable");
        std::fs::write(&file, b"").unwrap();
        assert!(!executable(dir.path()));
        #[cfg(unix)]
        assert!(!executable(&file));
    }
}
