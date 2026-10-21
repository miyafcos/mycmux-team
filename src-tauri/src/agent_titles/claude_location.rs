use std::path::{Path, PathBuf};

pub(crate) fn locate_exact_in_roots(
    primary: Option<&Path>,
    alternate: Option<&Path>,
    project_key: &str,
    session: &str,
) -> Option<PathBuf> {
    if session.is_empty() || session.len() > 128
        || !session.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return None;
    }
    let file_name = format!("{session}.jsonl");
    for root in [primary, alternate].into_iter().flatten() {
        let direct = root.join(project_key).join(&file_name);
        if direct.is_file() { return Some(direct); }
        let Ok(entries) = std::fs::read_dir(root) else { continue; };
        let mut found = None;
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir() && !kind.is_symlink()) { continue; }
            let candidate = entry.path().join(&file_name);
            if candidate.is_file() {
                if found.is_some() { return None; }
                found = Some(candidate);
            }
        }
        if found.is_some() { return found; }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("mycmux-title-roots-{}-{name}", std::process::id()));
        let primary = root.join("native");
        let alternate = root.join("wrapper");
        std::fs::create_dir_all(primary.join("project")).unwrap();
        std::fs::create_dir_all(alternate.join("project")).unwrap();
        (primary, alternate)
    }

    #[test]
    fn existing_misclassified_wrapper_resolves_only_the_exact_id() {
        let (primary, alternate) = roots("exact");
        let expected = alternate.join("project/current.jsonl");
        std::fs::write(&expected, b"{}").unwrap();
        std::fs::write(primary.join("project/neighbour.jsonl"), b"{}").unwrap();
        assert_eq!(locate_exact_in_roots(Some(&primary), Some(&alternate), "project", "current"), Some(expected));
        assert_eq!(locate_exact_in_roots(Some(&primary), Some(&alternate), "project", "missing"), None);
    }

    #[test]
    fn native_and_wrapper_roots_each_keep_their_own_matching_transcript() {
        let (primary, alternate) = roots("own");
        for root in [&primary, &alternate] { std::fs::write(root.join("project/current.jsonl"), b"{}").unwrap(); }
        for (own, other) in [(&primary, &alternate), (&alternate, &primary)] {
            assert_eq!(locate_exact_in_roots(Some(own), Some(other), "project", "current"), Some(own.join("project/current.jsonl")));
        }
    }

    #[test]
    fn cwd_changes_preserve_exact_ids_and_ambiguous_locations_are_rejected() {
        let (primary, alternate) = roots("moved");
        let expected = alternate.join("project/current.jsonl");
        std::fs::write(&expected, b"{}").unwrap();
        assert_eq!(locate_exact_in_roots(Some(&primary), Some(&alternate), "changed", "current"), Some(expected));
        std::fs::create_dir_all(alternate.join("duplicate")).unwrap();
        std::fs::write(alternate.join("duplicate/current.jsonl"), b"{}").unwrap();
        assert_eq!(locate_exact_in_roots(Some(&primary), Some(&alternate), "changed", "current"), None);
        for id in ["", "../current", "bad/name", "bad\\name"] {
            assert_eq!(locate_exact_in_roots(Some(&primary), Some(&alternate), "project", id), None);
        }
    }
}
