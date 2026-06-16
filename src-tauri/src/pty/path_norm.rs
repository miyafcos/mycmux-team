//! Path normalization utilities shared across OSC 7, monitor, and session log.

/// Convert a POSIX-style Git-Bash drive path (e.g. `/c/Users/...`) to a
/// Windows-style path (`C:\Users\...`). Returns the input unchanged if it
/// does not match the drive-letter pattern.
pub fn posix_drive_to_windows(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b'/' {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        let rest = path[2..].replace('/', "\\");
        format!("{drive}:{rest}")
    } else {
        path.to_string()
    }
}

/// Mangle a working directory into the `~/.claude/projects/<key>` directory name.
///
/// This must match Claude Code's raw cwd-derived project key and must not
/// canonicalize, because junctions, symlinks, and Windows path normalization can
/// produce a different on-disk project directory.
pub fn claude_project_key(path: &str) -> String {
    let normalized = if path.starts_with('/')
        && path.len() > 2
        && path.as_bytes()[1].is_ascii_alphabetic()
        && path.as_bytes()[2] == b'/'
    {
        format!(
            "{}:{}",
            path[1..2].to_uppercase(),
            path[2..].replace('/', "\\")
        )
    } else {
        path.to_string()
    };
    normalized
        .trim_end_matches(['/', '\\'])
        .replace([':', '\\', '/'], "-")
        .trim_start_matches('-')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_lower_drive() {
        assert_eq!(posix_drive_to_windows("/c/Users/me"), "C:\\Users\\me");
    }

    #[test]
    fn converts_upper_drive() {
        assert_eq!(posix_drive_to_windows("/D/projects"), "D:\\projects");
    }

    #[test]
    fn leaves_posix_untouched() {
        assert_eq!(posix_drive_to_windows("/home/me"), "/home/me");
    }

    #[test]
    fn leaves_windows_untouched() {
        assert_eq!(posix_drive_to_windows("C:\\Users\\me"), "C:\\Users\\me");
    }

    #[test]
    fn leaves_short_inputs() {
        assert_eq!(posix_drive_to_windows("/"), "/");
        assert_eq!(posix_drive_to_windows(""), "");
    }

    #[test]
    fn ignores_non_letter_first_segment() {
        assert_eq!(posix_drive_to_windows("/1/foo"), "/1/foo");
    }

    #[test]
    fn claude_project_key_strips_leading_separator_dash() {
        assert_eq!(claude_project_key("/Users/foo/bar"), "Users-foo-bar");
    }

    #[test]
    fn claude_project_key_mangles_windows_drive_path() {
        assert_eq!(claude_project_key(r"C:\Users\miyaz"), "C--Users-miyaz");
    }

    #[test]
    fn claude_project_key_mangles_posix_drive_path() {
        assert_eq!(claude_project_key("/c/Users/miyaz"), "C--Users-miyaz");
    }

    #[test]
    fn claude_project_key_trims_trailing_separators() {
        assert_eq!(claude_project_key(r"C:\Users\miyaz\"), "C--Users-miyaz");
    }
}
