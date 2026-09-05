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

/// Strip the Windows extended-length prefix (`\\?\`) that `fs::canonicalize`
/// prepends, so the path can be shown to a human or handed to an agent.
///
/// `\\?\C:\Users\me` → `C:\Users\me`, `\\?\UNC\server\share` → `\\server\share`.
/// Anything else is returned unchanged.
///
/// Keep canonical (prefixed) paths for our own file I/O — the prefix is what
/// lifts the MAX_PATH limit. Only strip it on the way out: agents reject the
/// prefixed form (Claude Code's Read denies `\\?\...` because it matches no
/// permission rule and reads as outside the working directory), and users
/// cannot paste it into a shell.
pub fn strip_extended_length_prefix(path: &str) -> String {
    match path.strip_prefix(r"\\?\") {
        Some(rest) => match rest.strip_prefix(r"UNC\") {
            Some(unc) => format!(r"\\{unc}"),
            None => rest.to_string(),
        },
        None => path.to_string(),
    }
}

/// Resolve a working directory to the canonical spelling used when matching a
/// pane's CWD against the CWD recorded inside an agent session file.
///
/// The three steps each fix a different way the same directory gets spelled:
///   1. Git-Bash drive paths (`/c/Users/me`) become Windows paths.
///   2. Trailing separators are dropped (`C:\src\` and `C:\src` are one place).
///   3. `canonicalize` resolves junctions, symlinks, 8.3 short names, and case,
///      so a pane launched through `C:\PROGRA~1\x` matches a session recorded
///      as `C:\Program Files\x`. This is the step that makes the key correct;
///      without it the two spellings look like different directories and an
///      agent session silently fails to resume. A path that does not exist is
///      left as-is — a missing directory has nothing to resolve, and the
///      caller still needs a stable key for it.
///
/// The `\\?\` prefix `canonicalize` adds is stripped again so the key can also
/// be shown in an error message.
pub fn normalize_agent_cwd(cwd: &str) -> String {
    let normalized = posix_drive_to_windows(cwd);
    #[cfg(not(windows))]
    let is_windows_drive_path = normalized
        .as_bytes()
        .get(1)
        .is_some_and(|byte| *byte == b':')
        && normalized
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic);
    let trimmed = normalized.trim_end_matches(['\\', '/']);
    let resolved = std::path::Path::new(trimmed)
        .canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| trimmed.to_string());
    let resolved = strip_extended_length_prefix(&resolved);
    #[cfg(windows)]
    {
        resolved.replace('/', "\\")
    }
    #[cfg(not(windows))]
    {
        if is_windows_drive_path {
            resolved.replace('/', "\\")
        } else {
            resolved
        }
    }
}

/// Case-insensitive form of [`normalize_agent_cwd`], for use as a lookup or
/// comparison key. Windows paths are case-insensitive, and agents record
/// whatever casing the user typed.
pub fn normalize_cwd_key(cwd: &str) -> String {
    normalize_agent_cwd(cwd).to_ascii_lowercase()
}

/// Mangle a working directory into the `~/.claude/projects/<key>` directory name.
///
/// This must match Claude Code's raw cwd-derived project key and must not
/// canonicalize, because junctions, symlinks, and Windows path normalization can
/// produce a different on-disk project directory.
pub fn claude_project_key(path: &str) -> String {
    posix_drive_to_windows(path)
        .trim_end_matches(['/', '\\'])
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect()
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
    fn strips_extended_length_drive_prefix() {
        assert_eq!(
            strip_extended_length_prefix(r"\\?\C:\Users\miyaz\.mycmux\online-dev\x\handoff.md"),
            r"C:\Users\miyaz\.mycmux\online-dev\x\handoff.md"
        );
    }

    #[test]
    fn strips_extended_length_unc_prefix() {
        assert_eq!(
            strip_extended_length_prefix(r"\\?\UNC\server\share\file.md"),
            r"\\server\share\file.md"
        );
    }

    #[test]
    fn leaves_plain_paths_untouched() {
        assert_eq!(
            strip_extended_length_prefix(r"C:\Users\miyaz\handoff.md"),
            r"C:\Users\miyaz\handoff.md"
        );
        assert_eq!(strip_extended_length_prefix("/home/me/handoff.md"), "/home/me/handoff.md");
        assert_eq!(strip_extended_length_prefix(""), "");
    }

    #[test]
    fn normalize_cwd_key_is_case_insensitive_and_drops_trailing_separators() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_string_lossy().to_string();
        assert_eq!(
            normalize_cwd_key(&base),
            normalize_cwd_key(&format!("{}\\", base.to_uppercase()))
        );
    }

    #[test]
    fn normalize_cwd_key_matches_posix_and_windows_spellings_of_one_directory() {
        // Only meaningful where a drive letter exists; on other platforms both
        // spellings still have to agree with each other.
        let windows = r"C:\Users";
        let posix = "/c/Users";
        assert_eq!(normalize_cwd_key(windows), normalize_cwd_key(posix));
    }

    #[test]
    fn normalize_agent_cwd_leaves_missing_directories_alone() {
        assert_eq!(
            normalize_agent_cwd(r"C:\mycmux-does-not-exist\sub\"),
            r"C:\mycmux-does-not-exist\sub"
        );
    }

    #[test]
    fn normalize_agent_cwd_resolves_a_relative_spelling_of_an_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("child");
        std::fs::create_dir(&nested).unwrap();
        let indirect = nested.join("..").join("child");
        assert_eq!(
            normalize_agent_cwd(&indirect.to_string_lossy()),
            normalize_agent_cwd(&nested.to_string_lossy())
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn normalize_agent_cwd_resolves_posix_symlink_before_any_separator_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert_eq!(
            normalize_agent_cwd(&link.to_string_lossy()),
            normalize_agent_cwd(&target.to_string_lossy())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn normalize_agent_cwd_handles_the_real_macos_home_path() {
        let home = dirs::home_dir().expect("macOS home directory should resolve");
        let indirect = home.join(".");
        assert_eq!(
            normalize_agent_cwd(&indirect.to_string_lossy()),
            home.canonicalize().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn claude_project_key_preserves_leading_separator_dash() {
        assert_eq!(claude_project_key("/Users/foo/bar"), "-Users-foo-bar");
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

    #[test]
    fn claude_project_key_sanitizes_dot_space_and_non_ascii() {
        assert_eq!(
            claude_project_key(r"C:\Users\miyaz\.ai-dashboard\master"),
            "C--Users-miyaz--ai-dashboard-master"
        );
        assert_eq!(
            claude_project_key(r"C:\Users\miyaz\Documents\New project"),
            "C--Users-miyaz-Documents-New-project"
        );
        assert_eq!(
            claude_project_key(r"C:\Users\miyaz\日本語"),
            "C--Users-miyaz----"
        );
    }
}
