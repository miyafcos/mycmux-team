//! What a document is allowed to point at on this machine.
//!
//! Both preview renderers turn text a document supplied into a path the pane
//! will open, and both have to refuse the same things: a path that climbs out
//! of its own root, a Windows device name, an alternate data stream, and a
//! target that names another machine. The rules lived in each renderer, written
//! out twice, with a comment in each saying the duplication was deliberate.
//!
//! That reasoning does not survive contact with a fix. A loophole closed in one
//! copy stays open in the other, and nothing fails when they drift — the tests
//! for each renderer keep passing against their own copy. One module, one set
//! of rules, and each renderer keeps its own tests over the shared code.

use std::path::{Component, Path, PathBuf};

/// Whether a target begins with two separators in any mix of slashes.
///
/// `\\server\share` and `//host/x` reach another machine, and `/\x` is the same
/// thing spelled to slip past a check that only looks for one of them. Loading
/// one as a picture is enough to send the reader's credentials there, with no
/// click involved.
pub(super) fn starts_with_two_separators(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && matches!(bytes[0], b'/' | b'\\') && matches!(bytes[1], b'/' | b'\\')
}

/// Resolves `.` and `..` without touching the disk, and refuses a path that
/// climbs above its own root or names a Windows device.
///
/// Lexical on purpose: asking the file system would follow links and would
/// answer differently depending on what happens to exist, so what a document
/// may reach would stop being decidable from the document alone.
pub(super) fn normalize_local_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    let mut depth = 0usize;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    continue;
                }
                normalized.pop();
                depth -= 1;
            }
            Component::Normal(segment) => {
                if !is_safe_path_segment(&segment.to_string_lossy()) {
                    return None;
                }
                normalized.push(segment);
                depth += 1;
            }
        }
    }
    (!normalized.as_os_str().is_empty()).then_some(normalized)
}

#[cfg(windows)]
pub(super) fn is_safe_path_segment(segment: &str) -> bool {
    // A colon here is an alternate data stream or a drive relative path, and a
    // reserved name is a device: opening either would not be reading a file.
    if segment.contains(':') {
        return false;
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return false;
    }
    let is_numbered_device = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|rest| rest.len() == 1 && rest.as_bytes()[0].is_ascii_digit())
    };
    !(is_numbered_device("COM") || is_numbered_device("LPT"))
}

#[cfg(not(windows))]
pub(super) fn is_safe_path_segment(segment: &str) -> bool {
    !segment.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_separators_are_found_in_every_mix_of_slashes() {
        for value in [r"\\server\share", "//host/x", r"/\x", r"\/x"] {
            assert!(starts_with_two_separators(value), "{value}");
        }
        for value in ["/x", r"\x", "x", "", "/"] {
            assert!(!starts_with_two_separators(value), "{value}");
        }
    }

    #[test]
    fn a_path_cannot_climb_out_of_its_own_root() {
        let climbed = normalize_local_path(Path::new("a/../../b")).expect("a path is left");
        assert!(!climbed.to_string_lossy().contains(".."));
        assert!(climbed.to_string_lossy().ends_with("b"));
    }

    #[test]
    fn dot_segments_are_resolved_without_the_disk() {
        let path = normalize_local_path(Path::new("a/./b/../c")).expect("a path is left");
        let spelling = path.to_string_lossy().replace('\\', "/");
        assert_eq!(spelling, "a/c");
    }

    #[test]
    fn an_empty_path_is_not_a_path() {
        assert!(normalize_local_path(Path::new("")).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn a_device_name_and_a_stream_are_refused() {
        for segment in ["CON", "con", "NUL.txt", "COM1", "lpt9", "file:stream", "CONIN$"] {
            assert!(!is_safe_path_segment(segment), "{segment}");
        }
        for segment in ["report.html", "COM", "COM10", "CONSOLE", "nullify.txt"] {
            assert!(is_safe_path_segment(segment), "{segment}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_device_name_anywhere_in_a_path_refuses_the_whole_path() {
        assert!(normalize_local_path(Path::new(r"C:\docs\NUL\x.png")).is_none());
    }
}
