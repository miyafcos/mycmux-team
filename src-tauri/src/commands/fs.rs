use serde::Serialize;
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
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    reveal_path_in_os_file_manager(Path::new(&path))
}

/// Open a file with the OS default application. For directories this is a
/// no-op in spirit (the UI hides this menu item for dirs). Cross-platform;
/// Windows delegates to Explorer so local files use the registered default app.
#[tauri::command(async)]
pub fn open_with_default(path: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let canonical = pb.canonicalize().unwrap_or(pb);
    #[cfg(target_os = "windows")]
    {
        let target = windows_display_path(&canonical);
        std::process::Command::new("explorer.exe")
            .arg(target)
            .spawn()
            .map_err(|e| format!("failed to launch default app: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("failed to launch open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("failed to launch xdg-open: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
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
pub async fn reveal_path_in_explorer(uri: String) -> Result<(), String> {
    crate::util::task::run_blocking("reveal_path_in_explorer", move || {
        let path = artifact_path_from_uri(&uri)?;
        reveal_path_in_os_file_manager(&path)
    })
    .await
}

/// Single implementation behind both reveal commands. Files are "revealed"
/// (parent opened with the file selected); directories are opened directly.
/// Cross-platform; mycmux ships on Windows so that path is the one exercised
/// in production.
fn reveal_path_in_os_file_manager(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.to_string_lossy()));
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let is_dir = canonical.is_dir();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .args(windows_explorer_reveal_args(&canonical, is_dir))
            .spawn()
            .map_err(|e| format!("failed to launch explorer.exe: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if !is_dir {
            cmd.arg("-R");
        }
        cmd.arg(&canonical)
            .spawn()
            .map_err(|e| format!("failed to launch open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if is_dir {
            canonical.to_path_buf()
        } else {
            canonical
                .parent()
                .map(|x| x.to_path_buf())
                .unwrap_or_else(|| canonical.to_path_buf())
        };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("failed to launch xdg-open: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

#[cfg(target_os = "windows")]
fn windows_display_path(path: &std::path::Path) -> String {
    let value = path.to_string_lossy();
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
}

#[cfg(target_os = "windows")]
fn windows_explorer_select_arg(path: &std::path::Path) -> String {
    format!("/select,{}", windows_display_path(path))
}

/// Explorer wants the select switch and the path in ONE argument
/// (`/select,C:\dir\file`). Splitting them into two arguments makes Explorer
/// ignore the selection and open the wrong folder for paths with spaces.
#[cfg(target_os = "windows")]
fn windows_explorer_reveal_args(path: &std::path::Path, is_dir: bool) -> Vec<String> {
    if is_dir {
        vec![windows_display_path(path)]
    } else {
        vec![windows_explorer_select_arg(path)]
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
    fn explorer_reveal_file_keeps_select_switch_and_path_in_one_argument() {
        let args = windows_explorer_reveal_args(
            std::path::Path::new(r"C:\Users\miyaz\Desktop\sample doc.html"),
            false,
        );
        assert_eq!(
            args,
            vec![r"/select,C:\Users\miyaz\Desktop\sample doc.html".to_string()]
        );
    }

    #[test]
    fn explorer_reveal_directory_opens_directory_directly() {
        let args =
            windows_explorer_reveal_args(std::path::Path::new(r"C:\Users\miyaz\Desktop"), true);
        assert_eq!(args, vec![r"C:\Users\miyaz\Desktop".to_string()]);
    }

    #[test]
    fn explorer_select_arg_keeps_switch_and_path_in_one_argument() {
        let arg = windows_explorer_select_arg(std::path::Path::new(
            r"C:\Users\miyaz\Desktop\sample doc.pdf",
        ));
        assert_eq!(arg, r"/select,C:\Users\miyaz\Desktop\sample doc.pdf");
    }

    #[test]
    fn artifact_explorer_args_open_directory_without_select() {
        let args = windows_explorer_reveal_args(
            std::path::Path::new(r"C:\Users\miyaz\Desktop\sample folder"),
            true,
        );
        assert_eq!(
            args,
            vec![r"C:\Users\miyaz\Desktop\sample folder".to_string()]
        );
    }

    #[test]
    fn artifact_explorer_args_select_file_with_existing_select_form() {
        let args = windows_explorer_reveal_args(
            std::path::Path::new(r"C:\Users\miyaz\Desktop\sample doc.pdf"),
            false,
        );
        assert_eq!(
            args,
            vec![r"/select,C:\Users\miyaz\Desktop\sample doc.pdf".to_string()]
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
