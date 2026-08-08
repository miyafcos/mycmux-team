//! Turning what the terminal handed us into a real file path, and picking the
//! preview file to show for it.
//!
//! The input is a URI or a raw path scraped out of terminal output, so it can
//! arrive percent-encoded, wrapped in CLI decoration, or soft-wrapped by the
//! terminal itself (which inserts spaces at the wrap column). Every repair here
//! exists because one of those forms was observed in the wild.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use super::markdown::markdown_to_static_html;
use super::office::office_to_static_html;
use super::{
    artifact_source_kind, ensure_artifact_file_within_read_limit, is_allowed_artifact_path,
    is_allowed_external_artifact_path, is_previewable_artifact, sidetab_session_dir,
};
pub(super) fn decode_file_uri(value: &str) -> String {
    let mut decoded = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &value[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn strip_ascii_spaces_around_path_separators(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut stripped = String::with_capacity(value.len());
    for index in 0..chars.len() {
        let ch = chars[index];
        if ch == ' ' || ch == '\t' {
            let mut next_is_separator = false;
            for next in &chars[index + 1..] {
                if *next == ' ' || *next == '\t' {
                    continue;
                }
                next_is_separator = *next == '/' || *next == '\\';
                break;
            }
            let prev_is_separator = stripped
                .chars()
                .rev()
                .find(|prev| *prev != ' ' && *prev != '\t')
                .map(|prev| prev == '/' || prev == '\\')
                .unwrap_or(false);
            if next_is_separator || prev_is_separator {
                continue;
            }
        }
        stripped.push(ch);
    }
    stripped
}

fn collapse_ascii_space_runs(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut in_ascii_space = false;
    for ch in value.chars() {
        if ch == ' ' || ch == '\t' {
            if !in_ascii_space {
                collapsed.push(' ');
            }
            in_ascii_space = true;
        } else {
            collapsed.push(ch);
            in_ascii_space = false;
        }
    }
    collapsed
}

fn strip_ascii_spaces_for_lookup(value: &str) -> String {
    value
        .chars()
        .filter(|ch| *ch != ' ' && *ch != '\t')
        .collect()
}

fn resolve_ascii_space_insensitive_existing_path(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }

    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => {
                resolved.push(prefix.as_os_str());
            }
            std::path::Component::RootDir => {
                resolved.push(component.as_os_str());
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => return None,
            std::path::Component::Normal(segment) => {
                let direct = resolved.join(segment);
                if direct.exists() {
                    resolved = direct;
                    continue;
                }

                let needle = strip_ascii_spaces_for_lookup(&segment.to_string_lossy());
                if needle.is_empty() || !resolved.is_dir() {
                    return None;
                }

                let mut matches = Vec::new();
                for entry in std::fs::read_dir(&resolved).ok()? {
                    let entry = entry.ok()?;
                    let candidate = entry.file_name();
                    if strip_ascii_spaces_for_lookup(&candidate.to_string_lossy()) == needle {
                        matches.push(entry.path());
                        if matches.len() > 1 {
                            return None;
                        }
                    }
                }

                resolved = matches.pop()?;
            }
        }
    }

    resolved.is_file().then_some(resolved)
}

fn artifact_path_from_decoded_uri(value: &str) -> PathBuf {
    #[cfg(windows)]
    {
        // MSYS / Git-Bash absolute path form: `/c/Users/...` -> `C:\Users\...`.
        // The drive must be a single ASCII letter framed by slashes so genuine
        // POSIX roots (`/home/...`, `/tmp/...`) are never mistaken for a drive.
        let bytes = value.as_bytes();
        if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b'/'
        {
            let drive = value[1..2].to_ascii_uppercase();
            let rest = &value[2..]; // keeps the leading '/', e.g. "/Users/..."
            return PathBuf::from(format!("{drive}:{rest}").replace('/', "\\"));
        }
        PathBuf::from(value.replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(value)
    }
}

pub(crate) fn artifact_path_from_uri(uri: &str) -> Result<PathBuf, String> {
    let mut value = uri
        .trim()
        .trim_end_matches(['.', ',', ';', ':', ')', ']', '}', '+', '＋']);
    if value.starts_with("file://") {
        value = &value[7..];
        if cfg!(windows) && value.starts_with('/') && value.len() > 2 && value.as_bytes()[2] == b':'
        {
            value = &value[1..];
        }
    }
    let decoded = decode_file_uri(value);
    let primary = artifact_path_from_decoded_uri(&decoded);
    if primary.is_file() {
        return Ok(primary);
    }

    let without_separator_padding = strip_ascii_spaces_around_path_separators(&decoded);
    let collapsed_spaces = collapse_ascii_space_runs(&decoded);
    let collapsed_without_separator_padding =
        strip_ascii_spaces_around_path_separators(&collapsed_spaces);
    for candidate in [
        without_separator_padding,
        collapsed_spaces,
        collapsed_without_separator_padding,
    ] {
        if candidate == decoded {
            continue;
        }
        let path = artifact_path_from_decoded_uri(&candidate);
        if path.is_file() {
            return Ok(path);
        }
        if let Some(path) = resolve_ascii_space_insensitive_existing_path(&path) {
            return Ok(path);
        }
    }

    if let Some(path) = resolve_ascii_space_insensitive_existing_path(&primary) {
        return Ok(path);
    }

    Ok(primary)
}

pub(super) fn external_markdown_preview_path(session_dir: &Path, path: &Path) -> Result<PathBuf, String> {
    external_artifact_preview_path(session_dir, path, "")
}

pub(super) fn external_office_preview_path(session_dir: &Path, path: &Path) -> Result<PathBuf, String> {
    external_artifact_preview_path(session_dir, path, "office")
}

fn external_artifact_preview_path(
    session_dir: &Path,
    path: &Path,
    preview_kind: &str,
) -> Result<PathBuf, String> {
    let previews_dir = session_dir.join("artifacts").join("previews");
    std::fs::create_dir_all(&previews_dir)
        .map_err(|error| format!("Failed to create preview directory: {error}"))?;
    let raw_stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("artifact");
    let mut safe_stem: String = raw_stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if safe_stem.is_empty() {
        safe_stem = "artifact".to_string();
    }
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy()
        .to_ascii_lowercase()
        .hash(&mut hasher);
    let preview_suffix = if preview_kind.is_empty() {
        "preview.html".to_string()
    } else {
        format!("{preview_kind}.preview.html")
    };
    Ok(previews_dir.join(format!(
        "{}-{:016x}.{}",
        safe_stem,
        hasher.finish(),
        preview_suffix
    )))
}

pub(super) fn preview_path_for_artifact(
    session_id: &str,
    path: &Path,
    allow_external: bool,
) -> Result<String, String> {
    let session_dir = sidetab_session_dir(session_id)?;
    let is_session_artifact = is_allowed_artifact_path(&session_dir, path);
    let is_external_artifact = allow_external && is_allowed_external_artifact_path(path);
    if (!is_session_artifact && !is_external_artifact) || !is_previewable_artifact(path) {
        return Err("Artifact path is outside this session preview area".to_string());
    }
    if !path.is_file() {
        return Err("Artifact file not found".to_string());
    }
    let source_kind =
        artifact_source_kind(path).ok_or_else(|| "Unsupported artifact source kind".to_string())?;
    match source_kind {
        "html" => Ok(path.to_string_lossy().to_string()),
        "markdown" => {
            ensure_artifact_file_within_read_limit(path, "preview")?;
            let markdown = std::fs::read_to_string(path)
                .map_err(|error| format!("Failed to read markdown artifact: {error}"))?;
            let preview_path = if is_session_artifact {
                path.with_extension("preview.html")
            } else {
                external_markdown_preview_path(&session_dir, path)?
            };
            std::fs::write(&preview_path, markdown_to_static_html(&markdown))
                .map_err(|error| format!("Failed to write markdown preview: {error}"))?;
            Ok(preview_path.to_string_lossy().to_string())
        }
        "office" => {
            ensure_artifact_file_within_read_limit(path, "preview")?;
            let preview_path = if is_session_artifact {
                path.with_extension("office.preview.html")
            } else {
                external_office_preview_path(&session_dir, path)?
            };
            std::fs::write(&preview_path, office_to_static_html(path))
                .map_err(|error| format!("Failed to write Office preview: {error}"))?;
            Ok(preview_path.to_string_lossy().to_string())
        }
        _ => Err("Unsupported artifact source kind".to_string()),
    }
}
