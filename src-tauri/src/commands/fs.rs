use serde::Serialize;
#[cfg(any(test, target_os = "windows"))]
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::artifact::artifact_path_from_uri;
use crate::pty::path_norm::posix_drive_to_windows;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLocalPathLink {
    pub existing_prefix: String,
    pub is_dir: bool,
}

/// Open the target in the OS file manager. Files are "revealed" (parent
/// opened with the file selected); directories are opened directly.
/// Cross-platform; mycmux ships on Windows so that path is the one
/// exercised in production.
#[tauri::command(async)]
pub async fn reveal_in_explorer(
    _trusted: crate::ipc_caller::TrustedAppCaller, path: String) -> Result<(), String> {
    crate::util::task::run_blocking("reveal_in_explorer", move || {
        reveal_path_in_os_file_manager(Path::new(&path))
    }).await
}

/// Open a file with the OS default application. For directories this is a
/// no-op in spirit (the UI hides this menu item for dirs). Cross-platform;
/// Windows delegates to Explorer so local files use the registered default app.
#[tauri::command(async)]
pub async fn open_with_default(
    _trusted: crate::ipc_caller::TrustedAppCaller, path: String) -> Result<(), String> {
    crate::util::task::run_blocking("open_with_default", move || {
        open_path_with_default_app_impl(Path::new(&path))
    }).await
}

#[tauri::command(async)]
pub async fn resolve_local_path_links(
    candidates: Vec<String>,
) -> Vec<Option<ResolvedLocalPathLink>> {
    let candidate_count = candidates.len();
    tauri::async_runtime::spawn_blocking(move || {
        candidates
            .iter()
            .map(|candidate| resolve_local_path_link(candidate))
            .collect()
    })
    .await
    .unwrap_or_else(|_| vec![None; candidate_count])
}

fn resolve_local_path_link(candidate: &str) -> Option<ResolvedLocalPathLink> {
    // FE-N2 fast path: most candidates fished out of terminal output are not
    // real paths at all (paths from another machine/container, typos, plain
    // prose that happens to contain a drive-letter-shaped substring, ...).
    // Before trying up to 64 word-boundary-cut substrings (each up to two
    // stats), check whether the drive root + first real directory component
    // exists at all. Every cut prefix is a textual prefix of `candidate`
    // (see `local_path_candidate_cut_prefixes`), so if that minimal root is
    // missing, no cut prefix can resolve to an existing path either and the
    // whole scan can be skipped in one stat.
    if !candidate_root_component_exists(candidate) {
        return None;
    }
    for existing_prefix in local_path_candidate_cut_prefixes(candidate) {
        if is_bare_local_path_prefix(existing_prefix) {
            continue;
        }
        let Some(metadata) = artifact_path_from_uri(existing_prefix)
            .ok()
            .and_then(|path| fs::metadata(path).ok())
            .or_else(|| local_path_candidate_to_path(existing_prefix).and_then(|path| fs::metadata(path).ok()))
        else {
            continue;
        };
        if metadata.is_dir() || metadata.is_file() {
            return Some(ResolvedLocalPathLink {
                existing_prefix: existing_prefix.to_string(),
                is_dir: metadata.is_dir(),
            });
        }
    }
    None
}

fn local_path_candidate_cut_prefixes(candidate: &str) -> Vec<&str> {
    let mut prefixes = Vec::new();
    push_candidate_cut_prefix(&mut prefixes, candidate);
    for (index, ch) in candidate.char_indices().rev() {
        if prefixes.len() >= 64 {
            break;
        }
        if is_local_path_boundary_char(ch) {
            push_candidate_cut_prefix(&mut prefixes, &candidate[..index]);
        }
    }
    prefixes
}

/// Cheap existence pre-filter for `resolve_local_path_link`.
///
/// Deliberately does *not* reuse the word-boundary-cut prefixes from
/// `local_path_candidate_cut_prefixes` as the "shortest candidate" to probe:
/// those cuts land on prose word boundaries (spaces, `、`, `。`, ...), which
/// can fall *inside* a single real path component (e.g. a directory literally
/// named "my folder"). Checking existence of such a cut could reject a
/// candidate whose real, longer prefix does exist.
///
/// Instead this walks `candidate`'s actual path components (real separators:
/// `\` / `/` only) and checks just the drive root plus first directory. That
/// is a genuine filesystem ancestor of anything `local_path_candidate_cut_prefixes`
/// could ever produce from `candidate` (every cut is a textual prefix of the
/// original string, so it shares this same leading root), so rejecting when
/// it is missing cannot produce a false negative. It mainly catches paths
/// that reference a different machine/container/OS root (e.g. `/home/...`,
/// `/app/...` copy-pasted from other terminal output) in a single stat,
/// rather than a fully accurate "does the full path exist" answer — a
/// missing leaf several components deep still falls through to the normal
/// scan below, which is unavoidable without duplicating real path-component
/// awareness into the word-boundary cutter itself.
fn candidate_root_component_exists(candidate: &str) -> bool {
    let Some(path) = local_path_candidate_to_path(candidate) else {
        // Nothing to convert (e.g. blank after trim) — let the normal scan
        // decide; it will find nothing to iterate either.
        return true;
    };
    let root: PathBuf = path.components().take(3).collect();
    if root.as_os_str().is_empty() {
        return true;
    }
    root.exists()
}

fn push_candidate_cut_prefix<'a>(prefixes: &mut Vec<&'a str>, candidate: &'a str) {
    let trimmed = candidate.trim_end_matches(is_local_path_cut_trim_char);
    if trimmed.is_empty() || prefixes.last().copied() == Some(trimmed) {
        return;
    }
    prefixes.push(trimmed);
}

fn is_local_path_boundary_char(ch: char) -> bool {
    matches!(ch, ' ' | '\u{3000}' | '\t' | '、' | '。' | '・')
}

fn is_local_path_cut_trim_char(ch: char) -> bool {
    is_local_path_boundary_char(ch)
        || matches!(ch, '.' | ',' | ';' | ':' | ')' | ']' | '}' | '+' | '＋')
}

fn is_bare_local_path_prefix(value: &str) -> bool {
    if let Some(rest) = value.strip_prefix("file:///") {
        return is_bare_drive_path_prefix(rest);
    }
    is_bare_drive_path_prefix(value) || is_bare_msys_drive_prefix(value)
}

fn is_bare_drive_path_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

fn is_bare_msys_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b'/'
}

fn local_path_candidate_to_path(value: &str) -> Option<PathBuf> {
    let mut path = value.trim();
    if path.is_empty() {
        return None;
    }
    if path.as_bytes().len() >= 7 && path.as_bytes()[..7].eq_ignore_ascii_case(b"file://") {
        path = &path[7..];
        if cfg!(windows) && path.starts_with('/') && path.len() > 2 && path.as_bytes()[2] == b':' {
            path = &path[1..];
        }
    }
    Some(PathBuf::from(posix_drive_to_windows(path)))
}

#[tauri::command(async)]
pub async fn reveal_path_in_explorer(
    _trusted: crate::ipc_caller::TrustedAppCaller, uri: String) -> Result<(), String> {
    crate::util::task::run_blocking("reveal_path_in_explorer", move || {
        let path = artifact_path_from_uri(&uri)?;
        reveal_path_in_os_file_manager(&path)
    })
    .await
}

#[tauri::command(async)]
pub async fn open_path_with_default_app(
    _trusted: crate::ipc_caller::TrustedAppCaller, uri: String) -> Result<(), String> {
    crate::util::task::run_blocking("open_path_with_default_app", move || {
        let path = artifact_path_from_uri(&uri)?;
        open_path_with_default_app_impl(&path)
    })
    .await
}

fn file_action_diagnostic(path: &Path, normalized: bool, route: &str, outcome: &str) -> String {
    let bytes = path.as_os_str().as_encoded_bytes();
    let format = if bytes.starts_with(br"\\?\") {
        "extended"
    } else if bytes.starts_with(br"\\") {
        "unc"
    } else if matches!(bytes, [drive, b':', b'\\' | b'/', ..] if drive.is_ascii_alphabetic()) {
        "drive"
    } else if path.is_absolute() {
        "absolute"
    } else {
        "relative"
    };
    format!("input={format} normalized={normalized} route={route} outcome={outcome}")
}

fn launch_file_action(
    scope: &str, original: &Path, normalized: bool, route: &str, mut command: std::process::Command,
) -> Result<(), String> {
    let result = command.spawn();
    let outcome = if result.is_ok() { "spawned" } else { "spawn_failed" };
    crate::diag::warn(scope, &file_action_diagnostic(original, normalized, route, outcome));
    result.map(|_| ()).map_err(|error| format!("failed to launch file manager or default app: {error}"))
}

/// Single implementation behind both reveal commands. Files are "revealed"
/// (parent opened with the file selected); directories are opened directly.
pub(super) fn reveal_path_in_os_file_manager(path: &Path) -> Result<(), String> {
    reveal_path_in_os_file_manager_with_original(path, path)
}

/// Reveal the checked path, preserving the original spelling for mapped-drive lookup.
pub(super) fn reveal_path_in_os_file_manager_with_original(path: &Path, original: &Path) -> Result<(), String> {
    if !path.exists() {
        crate::diag::warn("reveal", &file_action_diagnostic(original, false, "none", "missing"));
        return Err("path does not exist".into());
    }
    let normalized = path.canonicalize();
    let canonical = normalized.as_deref().unwrap_or(path);
    let is_dir = canonical.is_dir();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let target = windows_target_from_canonical(&normalized, path, original, |path| std::path::absolute(path));
        let mut command = std::process::Command::new("explorer.exe");
        command.raw_arg(windows_explorer_command_line(&target, is_dir));
        return launch_file_action("reveal", original, normalized.is_ok(),
            if is_dir { "explorer-open" } else { "explorer-select" }, command);
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if !is_dir { command.arg("-R"); }
        command.arg(canonical);
        return launch_file_action("reveal", original, normalized.is_ok(),
            if is_dir { "open" } else { "open-reveal" }, command);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if is_dir { canonical } else { canonical.parent().unwrap_or(canonical) };
        let mut command = std::process::Command::new("xdg-open");
        command.arg(target);
        return launch_file_action("reveal", original, normalized.is_ok(), "xdg-open", command);
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

fn open_path_with_default_app_impl(path: &Path) -> Result<(), String> {
    if !path.exists() {
        crate::diag::warn("open", &file_action_diagnostic(path, false, "none", "missing"));
        return Err("path does not exist".into());
    }
    let normalized = path.canonicalize();
    #[cfg(target_os = "windows")]
    let (route, target) = ("explorer.exe",
        windows_shell_path(&windows_target_from_canonical(&normalized, path, path, |path| std::path::absolute(path))));
    #[cfg(target_os = "macos")]
    let (route, target) = ("open", normalized.as_deref().unwrap_or(path));
    #[cfg(all(unix, not(target_os = "macos")))]
    let (route, target) = ("xdg-open", normalized.as_deref().unwrap_or(path));
    #[cfg(any(target_os = "windows", unix))]
    {
        let mut command = std::process::Command::new(route);
        command.arg(target);
        return launch_file_action("open", path, normalized.is_ok(), route, command);
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

#[cfg(any(test, target_os = "windows"))]
const WINDOWS_VERBATIM_UNC_PREFIX: &str = r"\\?\UNC\";

// Inspect Windows path spelling without using the host OS's path parser.
#[cfg(any(test, target_os = "windows"))]
fn select_windows_explorer_path(
    original_absolute: Option<PathBuf>,
    canonical: &Path,
) -> Cow<'_, Path> {
    if let Some(absolute) = original_absolute {
        let bytes = absolute.as_os_str().as_encoded_bytes();
        let drive_path = bytes.strip_prefix(br"\\?\").unwrap_or(bytes);
        if matches!(drive_path, [drive, b':', b'\\' | b'/', ..] if drive.is_ascii_alphabetic())
            && canonical
                .as_os_str()
                .as_encoded_bytes()
                .starts_with(WINDOWS_VERBATIM_UNC_PREFIX.as_bytes())
        {
            return Cow::Owned(absolute);
        }
    }
    Cow::Borrowed(canonical)
}

#[cfg(any(test, target_os = "windows"))]
fn windows_target_from_canonical<'a>(
    canonical: &'a std::io::Result<PathBuf>,
    fallback: &'a Path,
    original: &Path,
    absolute: impl FnOnce(&Path) -> std::io::Result<PathBuf>,
) -> Cow<'a, Path> {
    match canonical {
        Ok(path) => select_windows_explorer_path(absolute(original).ok(), path),
        Err(_) => Cow::Borrowed(fallback),
    }
}

#[cfg(all(test, target_os = "windows"))]
fn windows_explorer_target<'a>(original: Option<&Path>, canonical: &'a Path) -> Cow<'a, Path> {
    let absolute = original.and_then(|path| std::path::absolute(path).ok());
    select_windows_explorer_path(absolute, canonical)
}

/// Preprocess a Windows path for handing to explorer.exe (open or reveal).
/// Strips the `\\?\` long-path prefix (including UNC), normalizes separators,
/// and drops trailing backslashes except for a drive root (`C:\`).
#[cfg(any(test, target_os = "windows"))]
fn windows_shell_path(path: &Path) -> String {
    let mut value = path.to_string_lossy().into_owned();
    const LONG_PREFIX: &str = r"\\?\";
    if let Some(rest) = value.strip_prefix(WINDOWS_VERBATIM_UNC_PREFIX) {
        value = format!(r"\\{rest}");
    } else if let Some(rest) = value.strip_prefix(LONG_PREFIX) {
        value = rest.to_string();
    }
    value = value.replace('/', r"\");
    while value.ends_with('\\') {
        let without = &value[..value.len() - 1];
        if is_windows_drive_letter_colon(without) {
            break;
        }
        value.truncate(value.len() - 1);
        if value.is_empty() {
            break;
        }
    }
    value
}

#[cfg(any(test, target_os = "windows"))]
fn is_windows_drive_letter_colon(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[cfg(target_os = "windows")]
fn is_windows_drive_root(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
}

/// Returns the COMPLETE command line to hand to explorer.exe via raw_arg.
/// file -> `/select,"C:\dir\file"` ; directory -> `"C:\dir"` ; drive root -> `C:\` (unquoted)
#[cfg(target_os = "windows")]
fn windows_explorer_command_line(path: &Path, is_dir: bool) -> String {
    let shell_path = windows_shell_path(path);
    if is_windows_drive_root(&shell_path) {
        return shell_path;
    }
    if is_dir {
        format!("\"{shell_path}\"")
    } else {
        format!("/select,\"{shell_path}\"")
    }
}

#[cfg(test)]
mod windows_explorer_path_tests {
    use super::*;

    #[test]
    fn l6_keeps_the_original_verbatim_mapped_drive() {
        assert_eq!(
            shell_path(Some(r"\\?\X:\project\fixture.txt"), r"\\?\UNC\server\share\project\fixture.txt"),
            r"X:\project\fixture.txt"
        );
        assert_eq!(shell_path(Some(r"\\?\X:\"), r"\\?\UNC\server\share\"), r"X:\");
        assert_eq!(
            shell_path(Some(r"\\?\UNC\server\share\old"), r"\\?\UNC\server\share\new"),
            r"\\server\share\new"
        );
    }


    fn shell_path(original_absolute: Option<&str>, canonical: &str) -> String {
        let target =
            select_windows_explorer_path(original_absolute.map(PathBuf::from), Path::new(canonical));
        windows_shell_path(&target)
    }

    #[test]
    fn shell_target_uses_the_fallback_after_canonicalization_fails() {
        let failure = Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        let fallback = Path::new(r"relative\record.txt");
        let target = windows_target_from_canonical(&failure, fallback, Path::new(r"X:\alias"), |_| {
            panic!("the failed canonicalization must not select the alternate path");
        });
        assert_eq!(target.as_ref(), fallback);
    }

    #[test]
    fn shell_target_absolutizes_the_original_relative_input() {
        let canonical = Ok(PathBuf::from(r"\\?\UNC\server\share\record.txt"));
        let original = Path::new(r"relative\record.txt");
        let target = windows_target_from_canonical(&canonical, Path::new("fallback"), original, |raw| {
            assert_eq!(raw, original);
            Ok(PathBuf::from(r"X:\relative\record.txt"))
        });
        assert_eq!(target.as_ref(), Path::new(r"X:\relative\record.txt"));
    }

    #[test]
    fn mapped_directory_keeps_drive_path_and_strips_trailing_separator() {
        assert_eq!(
            shell_path(Some(r"X:\dir\sub\"), r"\\?\UNC\server\Share-1\dir\sub"),
            r"X:\dir\sub"
        );
    }

    #[test]
    fn mapped_file_keeps_spaces_and_japanese_and_normalizes_separators() {
        assert_eq!(
            shell_path(
                Some("X:/dir/a b/ファイル.pdf"),
                r"\\?\UNC\server\Share-1\dir\a b\ファイル.pdf",
            ),
            r"X:\dir\a b\ファイル.pdf"
        );
    }

    #[test]
    fn junction_to_mapped_drive_keeps_original_path() {
        assert_eq!(
            shell_path(
                Some(r"C:\Users\u\会社 Dropbox\名前\dir"),
                r"\\?\UNC\server\Share-1\dir",
            ),
            r"C:\Users\u\会社 Dropbox\名前\dir"
        );
    }

    #[test]
    fn original_unc_uses_canonical_unc_path() {
        assert_eq!(
            shell_path(Some(r"\\server\share\dir"), r"\\?\UNC\server\share\dir"),
            r"\\server\share\dir"
        );
        assert_eq!(
            shell_path(Some(r"\\server\alias\dir"), r"\\?\UNC\server\share\dir"),
            r"\\server\share\dir"
        );
    }

    #[test]
    fn local_canonical_path_keeps_existing_shell_path() {
        assert_eq!(shell_path(Some(r"C:\a\b"), r"\\?\C:\a\b"), r"C:\a\b");
        assert_eq!(shell_path(Some(r"C:\a\b"), r"\\?\C:\target\b"), r"C:\target\b");
    }

    #[test]
    fn mapped_drive_root_keeps_trailing_separator() {
        assert_eq!(shell_path(Some(r"X:\"), r"\\?\UNC\server\Share-1\"), r"X:\");
    }

    #[test]
    fn missing_absolute_candidate_keeps_fallback_shell_path() {
        assert_eq!(shell_path(None, r"C:/a b/"), r"C:\a b");
        assert_eq!(
            shell_path(None, r"\\?\UNC\server\Share-1\dir"),
            r"\\server\Share-1\dir"
        );
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "mycmux-resolve-local-path-links-{unique}-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn display_path(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn msys_path(path: &Path) -> String {
        let value = display_path(path).replace('\\', "/");
        let bytes = value.as_bytes();
        if bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'/' {
            let drive = char::from(bytes[0]).to_ascii_lowercase();
            format!("/{drive}{}", &value[2..])
        } else {
            value
        }
    }

    #[test]
    fn utf8_slice_regression_local_path_candidate_survives_multibyte_prefixes() {
        // Terminal link candidates can begin with multibyte prose. The old
        // file-scheme check sliced byte 7 even when it was inside a character.
        for candidate in [
            "レポート.md",
            "│ 出力",
            "日本語",
            "を参照",
            "file",
            "file:/",
        ] {
            assert_eq!(
                local_path_candidate_to_path(candidate),
                Some(PathBuf::from(candidate))
            );
        }
        assert_eq!(
            local_path_candidate_to_path("FILE://C:/x"),
            Some(PathBuf::from("C:/x"))
        );
    }

    #[tokio::test]
    async fn utf8_slice_regression_resolve_batch_survives_multibyte_candidate() {
        // A spawn-blocking panic is converted to an all-None result. Keep a
        // real second candidate so the old panic cannot look like success.
        let temp = TestTempDir::new();
        let dir = temp.path.join("resolved-after-japanese-candidate");
        std::fs::create_dir_all(&dir).unwrap();
        let dir_text = display_path(&dir);

        assert_eq!(
            resolve_local_path_links(vec!["日本語だけの候補".to_string(), dir_text.clone()]).await,
            vec![
                None,
                Some(ResolvedLocalPathLink {
                    existing_prefix: dir_text,
                    is_dir: true,
                }),
            ]
        );
    }

    #[test]
    fn explorer_command_line_file_with_spaces() {
        let line = windows_explorer_command_line(
            Path::new(r"C:\Users\miyaz\Desktop\sample doc.pdf"),
            false,
        );
        assert_eq!(
            line,
            r#"/select,"C:\Users\miyaz\Desktop\sample doc.pdf""#
        );
    }

    #[test]
    fn explorer_command_line_directory() {
        let line = windows_explorer_command_line(Path::new(r"C:\Users\miyaz\Desktop"), true);
        assert_eq!(line, r#""C:\Users\miyaz\Desktop""#);
    }

    #[test]
    fn explorer_command_line_japanese_space_and_forward_slashes() {
        let input = format!(
            "C:/Users/miyaz/Dropbox/\u{4e00}\u{6b21}\u{539f}\u{7a3f} v2/a b.md"
        );
        let line = windows_explorer_command_line(Path::new(&input), false);
        let expected = format!(
            "/select,\"C:\\Users\\miyaz\\Dropbox\\\u{4e00}\u{6b21}\u{539f}\u{7a3f} v2\\a b.md\""
        );
        assert_eq!(line, expected);
    }

    #[test]
    fn explorer_command_line_strips_trailing_separator() {
        assert_eq!(
            windows_explorer_command_line(Path::new(r#"C:\a b\"#), true),
            r#""C:\a b""#
        );
        assert_eq!(
            windows_explorer_command_line(Path::new(r"C:\a b/"), true),
            r#""C:\a b""#
        );
    }

    #[test]
    fn explorer_command_line_unc_long_path() {
        let line =
            windows_explorer_command_line(Path::new(r"\\?\UNC\server\share\dir"), true);
        assert_eq!(line, r#""\\server\share\dir""#);
    }

    #[test]
    fn explorer_command_line_strips_verbatim_prefix_for_file() {
        let line = windows_explorer_command_line(Path::new(r"\\?\C:\x\y.txt"), false);
        assert_eq!(line, r#"/select,"C:\x\y.txt""#);
    }

    #[test]
    fn explorer_command_line_drive_root_unquoted() {
        let line = windows_explorer_command_line(Path::new(r"C:\"), true);
        assert_eq!(line, r"C:\");
    }

    #[test]
    fn explorer_command_line_mapped_directory() {
        let target = windows_explorer_target(
            Some(Path::new(r"X:\dir\sub\")),
            Path::new(r"\\?\UNC\server\Share-1\dir\sub"),
        );
        assert_eq!(windows_explorer_command_line(&target, true), r#""X:\dir\sub""#);

        let root = windows_explorer_target(
            Some(Path::new(r"X:\")),
            Path::new(r"\\?\UNC\server\Share-1\"),
        );
        assert_eq!(windows_explorer_command_line(&root, true), r"X:\");
    }

    #[test]
    fn explorer_command_line_mapped_file() {
        let target = windows_explorer_target(
            Some(Path::new("X:/dir/skip/../a b/ファイル.pdf")),
            Path::new(r"\\?\UNC\server\Share-1\dir\a b\ファイル.pdf"),
        );
        assert_eq!(
            windows_explorer_command_line(&target, false),
            r#"/select,"X:\dir\a b\ファイル.pdf""#
        );
    }

    #[test]
    fn resolve_local_path_link_handles_extensionless_dirs_files_and_prose() {
        let temp = TestTempDir::new();
        let dir = temp.path.join("3_一次原稿");
        let spaced_dir = temp.path.join("my folder");
        let extensionless_file = temp.path.join("artifact without extension");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&spaced_dir).unwrap();
        std::fs::write(&extensionless_file, "ok").unwrap();

        let dir_text = display_path(&dir);
        let spaced_dir_text = display_path(&spaced_dir);
        let file_text = display_path(&extensionless_file);

        assert_eq!(
            resolve_local_path_link(&dir_text),
            Some(ResolvedLocalPathLink {
                existing_prefix: dir_text.clone(),
                is_dir: true,
            })
        );
        assert_eq!(
            resolve_local_path_link(&format!("{spaced_dir_text} を参照")),
            Some(ResolvedLocalPathLink {
                existing_prefix: spaced_dir_text.clone(),
                is_dir: true,
            })
        );
        assert_eq!(
            resolve_local_path_link(&format!("{dir_text}。")),
            Some(ResolvedLocalPathLink {
                existing_prefix: dir_text.clone(),
                is_dir: true,
            })
        );
        assert_eq!(
            resolve_local_path_link(&file_text),
            Some(ResolvedLocalPathLink {
                existing_prefix: file_text,
                is_dir: false,
            })
        );
    }

    #[test]
    fn resolve_local_path_link_rejects_missing_and_bare_prefix_candidates() {
        let temp = TestTempDir::new();
        let missing = display_path(&temp.path.join("does not exist"));

        assert_eq!(resolve_local_path_link(&missing), None);
        assert_eq!(resolve_local_path_link(r"C:\"), None);
        assert_eq!(resolve_local_path_link("/c/"), None);
        assert_eq!(resolve_local_path_link("file:///C:/"), None);
    }

    #[test]
    fn resolve_local_path_link_accepts_msys_form_and_returns_input_substring() {
        let temp = TestTempDir::new();
        let dir = temp.path.join("my folder").join("3_一次原稿");
        std::fs::create_dir_all(&dir).unwrap();

        let candidate = format!("{} を参照", msys_path(&dir));
        let resolved = resolve_local_path_link(&candidate).unwrap();

        assert!(resolved.is_dir);
        assert!(candidate.contains(&resolved.existing_prefix));
        assert_eq!(resolved.existing_prefix, msys_path(&dir));
    }

    // FE-N2 regression coverage: the early root-component rejection must
    // reject genuinely fictional path-looking strings without breaking any
    // of the resolution behavior above.

    #[test]
    fn candidate_root_component_exists_matches_real_and_fake_drive_roots() {
        // A real, always-present directory: the check should not reject it.
        assert!(candidate_root_component_exists(r"C:\Users\someone\file.txt"));
        // A first-level directory that (almost certainly) does not exist at
        // the drive root should be rejected in the cheap pre-check.
        assert!(!candidate_root_component_exists(
            r"C:\mycmux-fe-n2-definitely-not-a-real-directory-8f3c1\deep\file.txt"
        ));
        // Bare drive root alone — nothing to probe below it, must not reject.
        assert!(candidate_root_component_exists(r"C:\"));
    }

    #[test]
    fn resolve_local_path_link_rejects_fictional_root_without_scanning_full_prefix_list() {
        // No real filesystem I/O needed beyond the drive-root probe: this
        // directory name is unique enough that it cannot exist for real, so
        // `resolve_local_path_link` must return None via the fast path.
        let candidate = concat!(
            r"C:\mycmux-fe-n2-definitely-not-a-real-directory-8f3c1",
            r"\deeply\nested\path\that\does\not\exist\report.txt for details"
        );
        assert_eq!(resolve_local_path_link(candidate), None);
    }

    #[test]
    fn resolve_local_path_link_still_resolves_real_paths_with_spaces_after_root_prefilter() {
        // Guards against a naive "reject if the shortest word-boundary-cut
        // prefix doesn't exist" implementation: that shortest cut can land
        // inside a real directory name containing a space (e.g. "my folder"
        // cut down to just "my"), which must not be used as the rejection
        // signal. The FE-N2 pre-filter instead only probes the drive root +
        // first real path component, so this must still resolve correctly.
        let temp = TestTempDir::new();
        let dir = temp.path.join("my folder").join("nested nested-two");
        std::fs::create_dir_all(&dir).unwrap();

        let dir_text = display_path(&dir);
        assert_eq!(
            resolve_local_path_link(&format!("{dir_text} を参照")),
            Some(ResolvedLocalPathLink {
                existing_prefix: dir_text,
                is_dir: true,
            })
        );
    }
}

#[cfg(test)]
#[test]
fn l6_fix2_missing_path_diagnostic_does_not_log_the_input_or_error_path() {
    let path = Path::new("sample/person@example.test/file.pdf");
    let diagnostic = file_action_diagnostic(path, false, "none", "missing");
    assert!(!diagnostic.contains("person@example.test"));
    assert!(!diagnostic.contains("file.pdf"));
    assert!(diagnostic.contains("missing"));
}
