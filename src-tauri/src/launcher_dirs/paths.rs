pub fn normalize_path(raw: &str) -> String {
    let mut path = raw.trim().replace('\\', "/");
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            path = format!(
                "{}{}",
                home.to_string_lossy().replace('\\', "/"),
                &path[1..]
            );
        }
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && (bytes.len() == 2 || bytes[2] == b'/')
    {
        path = format!(
            "{}:/{}",
            (bytes[1] as char).to_ascii_uppercase(),
            path.get(3..).unwrap_or("")
        );
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        path.replace_range(..1, &(bytes[0] as char).to_ascii_uppercase().to_string());
    }
    while path.ends_with('/') && path.len() > 1 {
        if path.len() == 3 && path.as_bytes()[1] == b':' {
            break;
        }
        path.pop();
    }
    path
}

pub fn path_key(path: &str) -> String {
    let normalized = normalize_path(path);
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

pub fn folder_name(path: &str) -> String {
    let normalized = normalize_path(path);
    normalized
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(&normalized)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_separators_drives_and_trailing_slashes() {
        assert_eq!(
            normalize_path("c:\\Users\\example\\repo\\"),
            "C:/Users/example/repo"
        );
        assert_eq!(
            normalize_path("/c/Users/example/repo/"),
            "C:/Users/example/repo"
        );
        assert_eq!(normalize_path("c:////"), "C:/");
        assert_eq!(normalize_path("/c/"), "C:/");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path("/tmp/repo/"), "/tmp/repo");
    }

    #[test]
    fn expands_only_the_current_users_home() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            normalize_path("~/repo/"),
            normalize_path(&home.join("repo").to_string_lossy())
        );
        assert_eq!(normalize_path("~"), normalize_path(&home.to_string_lossy()));
        assert_eq!(normalize_path("~someone/repo"), "~someone/repo");
        assert_eq!(folder_name("C:/space dir/repo/"), "repo");
    }

    #[test]
    fn keys_fold_case_only_on_windows() {
        assert_eq!(path_key("/c/Repo/"), path_key("C:\\Repo"));
        assert_eq!(path_key("C:/REPO") == path_key("c:/repo"), cfg!(windows));
    }
}
