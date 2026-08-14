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

#[cfg(test)]
mod tests {
    use super::*;

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
            "remote-token",
            "remote.port",
            "savepoint.json",
            "savepoints",
        ] {
            assert_eq!(runtime.join(child), PathBuf::from(format!("C:/Users/example/.mycmux-rc-1/{child}")));
        }
    }
}
