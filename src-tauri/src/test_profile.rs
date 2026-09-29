use std::path::PathBuf;
use std::sync::OnceLock;

static PROFILE_NAME: OnceLock<Option<String>> = OnceLock::new();

fn parse_profile(args: impl IntoIterator<Item = String>) -> Result<Option<String>, String> {
    let mut args = args.into_iter();
    let _program = args.next();
    let mut profile = None;
    while let Some(arg) = args.next() {
        if arg != "--profile" {
            continue;
        }
        let value = args
            .next()
            .ok_or_else(|| "--profile requires a name".to_string())?;
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err("--profile accepts only letters, digits, '-' and '_' (1-64 chars)".into());
        }
        if profile.replace(value).is_some() {
            return Err("--profile may be specified only once".into());
        }
    }
    Ok(profile)
}

pub fn init_from_args() -> Result<(), String> {
    let profile = parse_profile(std::env::args())?;
    PROFILE_NAME
        .set(profile)
        .map_err(|_| "test profile was initialized more than once".to_string())
}

// Lives in this module rather than lib.rs: the command macro on a pub fn
// at the crate root collides with its own generated __cmd__ re-export (E0255).
#[tauri::command]
pub fn get_test_profile() -> Option<String> {
    name().map(str::to_string)
}

pub fn name() -> Option<&'static str> {
    PROFILE_NAME.get().and_then(|profile| profile.as_deref())
}

pub fn is_active() -> bool {
    name().is_some()
}

pub fn runtime_dir_from(home: PathBuf) -> PathBuf {
    runtime_dir_for(name(), home)
}

fn runtime_dir_for(profile: Option<&str>, home: PathBuf) -> PathBuf {
    match profile {
        Some(profile) => home.join(format!(".mycmux-{profile}")),
        None => home.join(".mycmux"),
    }
}

pub fn runtime_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home directory is not available".to_string())?;
    Ok(runtime_dir_from(home))
}

pub fn app_data_dir_from(default_dir: PathBuf) -> PathBuf {
    app_data_dir_for(name(), default_dir)
}

fn app_data_dir_for(profile: Option<&str>, default_dir: PathBuf) -> PathBuf {
    match profile {
        Some(profile) => default_dir.join("profiles").join(profile),
        None => default_dir,
    }
}

/// Filename the window-state plugin saves the main window's geometry under,
/// relative to Tauri's app config dir. The plugin resolves that dir itself, so
/// it never saw the profile redirection: a test profile restored the live
/// window's geometry at launch and overwrote `.window-state.json` on a graceful
/// exit (2026-09-25, a perf test machine rewrote the production file).
pub fn window_state_filename() -> String {
    window_state_filename_for(name())
}

fn window_state_filename_for(profile: Option<&str>) -> String {
    match profile {
        Some(profile) => format!("profiles/{profile}/{}", tauri_plugin_window_state::DEFAULT_FILENAME),
        None => tauri_plugin_window_state::DEFAULT_FILENAME.to_string(),
    }
}

/// The directory `window_state_filename` lives in, which the plugin does not
/// create (it only creates the app config dir itself).
pub fn window_state_dir(app_config_dir: &std::path::Path) -> Option<PathBuf> {
    name().map(|profile| app_config_dir.join("profiles").join(profile))
}

/// macOS only: an automated harness driving a `--profile` build on a Mac
/// someone is working on can ask the app not to take the screen. tao activates
/// the app on launch even under `open -g`, so the policy has to be lowered
/// before the run loop starts. Ignored without a profile.
#[cfg(target_os = "macos")]
pub fn activation_policy_override() -> Option<tauri::ActivationPolicy> {
    if !is_active() {
        return None;
    }
    activation_policy_for(std::env::var("MYCMUX_PROFILE_ACTIVATION").ok().as_deref())
}

#[cfg(target_os = "macos")]
fn activation_policy_for(value: Option<&str>) -> Option<tauri::ActivationPolicy> {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("accessory") => Some(tauri::ActivationPolicy::Accessory),
        Some("prohibited") => Some(tauri::ActivationPolicy::Prohibited),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_state_file_stays_under_the_profile_dir() {
        assert_eq!(window_state_filename_for(None), ".window-state.json");
        assert_eq!(window_state_filename_for(Some("perf3")), "profiles/perf3/.window-state.json");
        assert_eq!(
            PathBuf::from("C:/AppData/com.miyazaki.mycmux").join(window_state_filename_for(Some("perf3"))),
            app_data_dir_for(Some("perf3"), PathBuf::from("C:/AppData/com.miyazaki.mycmux")).join(".window-state.json")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn activation_policy_override_only_accepts_the_two_background_policies() {
        assert!(matches!(activation_policy_for(Some("accessory")), Some(tauri::ActivationPolicy::Accessory)));
        assert!(matches!(activation_policy_for(Some(" Prohibited ")), Some(tauri::ActivationPolicy::Prohibited)));
        assert!(activation_policy_for(Some("regular")).is_none());
        assert!(activation_policy_for(None).is_none());
    }

    #[test]
    fn profile_name_is_strictly_safe_for_a_directory_component() {
        assert_eq!(parse_profile(["mycmux".into(), "--profile".into(), "rc_1".into()]).unwrap(), Some("rc_1".into()));
        for invalid in ["", "../prod", "a/b", "a b", "日本語"] {
            assert!(parse_profile(["mycmux".into(), "--profile".into(), invalid.into()]).is_err());
        }
    }

    #[test]
    fn default_paths_remain_the_legacy_paths() {
        let home = PathBuf::from("C:/Users/example");
        let app_data = PathBuf::from("C:/AppData/com.miyazaki.mycmux");
        assert_eq!(runtime_dir_for(None, home), PathBuf::from("C:/Users/example/.mycmux"));
        assert_eq!(app_data_dir_for(None, app_data), PathBuf::from("C:/AppData/com.miyazaki.mycmux"));
    }

    #[test]
    fn profile_paths_are_separate_from_the_legacy_paths() {
        assert_eq!(runtime_dir_for(Some("rc-1"), PathBuf::from("C:/Users/example")), PathBuf::from("C:/Users/example/.mycmux-rc-1"));
        assert_eq!(app_data_dir_for(Some("rc-1"), PathBuf::from("C:/AppData/com.miyazaki.mycmux")), PathBuf::from("C:/AppData/com.miyazaki.mycmux/profiles/rc-1"));
    }

    #[test]
    fn profile_runtime_children_stay_under_the_profile_root() {
        let runtime = runtime_dir_for(Some("rc-1"), PathBuf::from("C:/Users/example"));

        for child in [
            "pane-sessions",
            "mycmux.port",
            "mycmux.token",
            "savepoint.json",
            "savepoints",
        ] {
            assert_eq!(runtime.join(child), PathBuf::from(format!("C:/Users/example/.mycmux-rc-1/{child}")));
        }
    }
}
