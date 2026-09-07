use super::{manifest, pack_rules, Entry, InstallResult, Manifest, PACK_CLI, PACK_FILES};
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
pub(super) const MARKER: &str = ".mycmux-pack.json";

fn normalized_bytes(path: &Path, data: &[u8]) -> Vec<u8> {
    if !pack_rules::is_text(path) {
        return data.to_vec();
    }
    let mut result = Vec::with_capacity(data.len());
    let mut index = 0;
    while index < data.len() {
        if data[index] == b'\r' {
            result.push(b'\n');
            if data.get(index + 1) == Some(&b'\n') {
                index += 1;
            }
        } else {
            result.push(data[index]);
        }
        index += 1;
    }
    result
}
fn sha(path: &Path, data: &[u8]) -> String {
    hex::encode(Sha256::digest(normalized_bytes(path, data)))
}
fn read(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}
fn hashes(root: &Path) -> Result<BTreeMap<String, String>, String> {
    fn walk(root: &Path, dir: &Path, result: &mut BTreeMap<String, String>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if pack_rules::excluded_part(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let path = entry.path();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                return Err(format!("symlink is not supported: {}", path.display()));
            }
            if kind.is_dir() {
                walk(root, &path, result)?;
            } else if kind.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                result.insert(rel, sha(&path, &read(&path)?));
            }
        }
        Ok(())
    }
    let mut result = BTreeMap::new();
    // pathlib.rglob on a plain file returns no files.
    if root.is_dir() {
        walk(root, root, &mut result)?;
    }
    Ok(result)
}
pub(super) fn state(dest: &Path, entry: &Entry, version: &str) -> &'static str {
    if !dest.exists() {
        return "not-installed";
    }
    let inspected = (|| -> Result<bool, String> {
        let marker: Value =
            serde_json::from_slice(&read(&dest.join(MARKER))?).map_err(|e| e.to_string())?;
        let actual = hashes(dest)?;
        if marker.get("sha256") != Some(&json!(actual)) {
            return Err("local changes".into());
        }
        Ok(actual == entry.files
            && marker.get("pack_version").and_then(Value::as_str) == Some(version))
    })();
    match inspected {
        Ok(true) => "latest",
        Ok(false) => "outdated",
        Err(_) => "locally-modified",
    }
}
fn cli_path(home: &Path) -> PathBuf {
    home.join(".mycmux/bin/mycmux_agent_cli.py")
}
pub(super) fn cli_state(home: &Path, manifest: &Manifest) -> Result<&'static str, String> {
    let path = cli_path(home);
    if !path.is_file() {
        return Ok("not-installed");
    }
    Ok(if sha(&path, &read(&path)?) == manifest.cli.sha256 {
        "latest"
    } else {
        "outdated"
    })
}
fn reject_symlinks(home: &Path, path: &Path) -> Result<(), String> {
    // Only the managed part below the home directory is inspected. Platform
    // ancestors are none of our business: macOS keeps temporary homes under
    // /var, which is itself a symlink to /private/var (measured 2026-09-07).
    let scope: Vec<&Path> = if path.starts_with(home) {
        path.ancestors().take_while(|a| *a != home).collect()
    } else {
        vec![path]
    };
    for ancestor in scope {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!(
                    "symlink destination is not supported: {}",
                    ancestor.display()
                ))
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("{}: {e}", ancestor.display())),
        }
    }
    Ok(())
}
fn canonical_write_bytes(path: &Path, data: &[u8]) -> Result<Vec<u8>, String> {
    let data = normalized_bytes(path, data);
    if pack_rules::is_text(path) {
        let text = std::str::from_utf8(&data).map_err(|e| e.to_string())?;
        if text.starts_with('\u{feff}') || text.contains('\u{fffd}') {
            return Err(format!(
                "text must be UTF-8 without BOM or replacement characters: {}",
                path.display()
            ));
        }
    }
    Ok(data)
}
fn write(home: &Path, path: &Path, data: &[u8]) -> Result<(), String> {
    reject_symlinks(home, path)?;
    let normalized = normalized_bytes(path, data);
    if path.is_file() && read(path)? == normalized {
        return Ok(());
    }
    let data = canonical_write_bytes(path, &normalized)?;
    fs::create_dir_all(path.parent().ok_or("missing parent")?).map_err(|e| e.to_string())?;
    fs::write(path, &data).map_err(|e| format!("{}: {e}", path.display()))?;
    if read(path)? != data {
        return Err(format!("write verification failed: {}", path.display()));
    }
    Ok(())
}
fn backup(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or("missing filename")?
        .to_string_lossy();
    let stamp = Utc::now().format("%Y%m%dT%H%M%S%6fZ");
    let dest = path.with_file_name(format!("{name}.bak-{stamp}"));
    if fs::symlink_metadata(&dest).is_ok() {
        return Err(format!("backup already exists: {}", dest.display()));
    }
    fs::rename(path, &dest).map_err(|e| format!("backup {}: {e}", path.display()))?;
    Ok(dest)
}
fn payload(name: &str, rel: &str) -> Result<&'static [u8], String> {
    let key = format!("{name}/{rel}");
    PACK_FILES
        .iter()
        .find(|(path, _)| *path == key)
        .map(|(_, data)| *data)
        .ok_or_else(|| format!("missing embedded file: {key}"))
}
fn validate_pack(manifest: &Manifest) -> Result<(), String> {
    let mut expected = BTreeSet::from(["manifest.json".to_string()]);
    for entry in &manifest.skills {
        if entry.name.is_empty()
            || entry.name.contains(['/', '\\'])
            || matches!(entry.name.as_str(), "." | "..")
        {
            return Err("invalid embedded skill name".into());
        }
        for (rel, hash) in &entry.files {
            if rel.contains('\\')
                || rel
                    .split('/')
                    .any(|v| v.is_empty() || v == "." || v == ".." || v.contains(':'))
                || Path::new(rel).is_absolute()
            {
                return Err(format!("invalid embedded path: {rel}"));
            }
            expected.insert(format!("{}/{rel}", entry.name));
            let data = payload(&entry.name, rel)?;
            canonical_write_bytes(Path::new(rel), data)?;
            if sha(Path::new(rel), data) != *hash {
                return Err(format!("embedded hash mismatch: {}/{rel}", entry.name));
            }
        }
    }
    let actual: BTreeSet<_> = PACK_FILES
        .iter()
        .map(|(path, _)| path.to_string())
        .collect();
    if actual != expected || actual.len() != PACK_FILES.len() {
        return Err("embedded file set mismatch".into());
    }
    canonical_write_bytes(Path::new("mycmux_agent_cli.py"), PACK_CLI)?;
    if sha(Path::new("mycmux_agent_cli.py"), PACK_CLI) != manifest.cli.sha256 {
        return Err("embedded CLI hash mismatch".into());
    }
    Ok(())
}
pub(super) fn install_at(home: &Path, names: &[String], force: bool) -> InstallResult {
    let mut result = InstallResult::default();
    let attempt = (|| -> Result<(), String> {
        let manifest = manifest()?;
        validate_pack(&manifest)?;
        let unique: BTreeSet<_> = names.iter().collect();
        if unique.len() != names.len()
            || names
                .iter()
                .any(|name| !manifest.skills.iter().any(|e| &e.name == name))
        {
            return Err("select unique names from the embedded manifest".into());
        }
        let entries: Vec<_> = manifest
            .skills
            .iter()
            .filter(|e| names.contains(&e.name))
            .collect();
        // Collect every preflight error before any skill or CLI write.
        for entry in &entries {
            let dest = home.join(".claude/skills").join(&entry.name);
            if let Err(e) = reject_symlinks(home, &dest) {
                result.errors.push(e);
            }
            let status = state(&dest, entry, &manifest.pack_version);
            if status == "locally-modified" && !force {
                result.errors.push(format!(
                    "{}: local changes; backup and replace required",
                    entry.name
                ));
            }
            if status == "latest" {
                for rel in entry
                    .files
                    .keys()
                    .map(String::as_str)
                    .chain(std::iter::once(MARKER))
                {
                    if let Err(e) = reject_symlinks(home, &dest.join(rel)) {
                        result.errors.push(e);
                    }
                }
                if let Err(e) = read(&dest.join(MARKER))
                    .and_then(|bytes| canonical_write_bytes(&dest.join(MARKER), &bytes))
                {
                    result.errors.push(e);
                }
            }
        }
        let cli = cli_path(home);
        if let Err(e) = reject_symlinks(home, &cli) {
            result.errors.push(e);
        }
        if !result.errors.is_empty() {
            return Ok(());
        }
        for entry in entries {
            let dest = home.join(".claude/skills").join(&entry.name);
            let status = state(&dest, entry, &manifest.pack_version);
            if status == "latest" {
                for rel in entry.files.keys() {
                    write(home, &dest.join(rel), payload(&entry.name, rel)?)?;
                }
                write(home, &dest.join(MARKER), &read(&dest.join(MARKER))?)?;
                result.skipped.push(entry.name.clone());
                continue;
            }
            if dest.exists() {
                result
                    .backups
                    .push(backup(&dest)?.to_string_lossy().into_owned());
            }
            for rel in entry.files.keys() {
                write(home, &dest.join(rel), payload(&entry.name, rel)?)?;
            }
            // Declaration order also matches Python json_bytes for the marker.
            #[derive(serde::Serialize)]
            struct Marker<'a> {
                pack_version: &'a str,
                sha256: &'a BTreeMap<String, String>,
                installed_at: String,
            }
            let marker = Marker {
                pack_version: &manifest.pack_version,
                sha256: &entry.files,
                installed_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false),
            };
            let mut bytes = serde_json::to_vec_pretty(&marker).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
            write(home, &dest.join(MARKER), &bytes)?;
            result.installed.push(entry.name.clone());
        }
        if cli_state(home, &manifest)? == "latest" {
            write(home, &cli, PACK_CLI)?;
            result.skipped.push("agent CLI".into());
        } else {
            if cli.exists() {
                result
                    .backups
                    .push(backup(&cli)?.to_string_lossy().into_owned());
            }
            write(home, &cli, PACK_CLI)?;
            result.installed.push("agent CLI".into());
        }
        Ok(())
    })();
    if let Err(e) = attempt {
        result.errors.push(e);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn names() -> Vec<String> {
        manifest()
            .unwrap()
            .skills
            .into_iter()
            .map(|e| e.name)
            .collect()
    }
    fn install(home: &Path) -> InstallResult {
        let result = install_at(home, &names(), false);
        assert!(result.errors.is_empty(), "{result:?}");
        result
    }
    #[test]
    fn embedded_hashes_and_file_set_match_python_manifest() {
        validate_pack(&manifest().unwrap()).unwrap();
        assert_eq!(
            PACK_FILES
                .iter()
                .find(|(name, _)| *name == "manifest.json")
                .unwrap()
                .1,
            super::super::PACK_MANIFEST
        );
    }
    #[test]
    fn fresh_install_then_second_install_is_noop() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(install(home.path()).installed.len(), 4);
        let m = manifest().unwrap();
        let mut before = Vec::new();
        for entry in &m.skills {
            let dest = home.path().join(".claude/skills").join(&entry.name);
            assert_eq!(state(&dest, entry, &m.pack_version), "latest");
            assert_eq!(hashes(&dest).unwrap(), entry.files);
            let marker = dest.join(MARKER);
            let value: Value = serde_json::from_slice(&read(&marker).unwrap()).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 3);
            chrono::DateTime::parse_from_rfc3339(value["installed_at"].as_str().unwrap()).unwrap();
            for rel in entry
                .files
                .keys()
                .map(String::as_str)
                .chain(std::iter::once(MARKER))
            {
                let path = dest.join(rel);
                before.push((
                    path.clone(),
                    read(&path).unwrap(),
                    fs::metadata(&path).unwrap().modified().unwrap(),
                ));
            }
        }
        let result = install(home.path());
        assert_eq!(result.skipped.len(), 4);
        assert!(result.installed.is_empty() && result.backups.is_empty());
        for (path, bytes, modified) in before {
            assert_eq!(read(&path).unwrap(), bytes);
            assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), modified);
        }
    }
    #[test]
    fn modified_preflight_changes_nothing_and_force_keeps_backup() {
        let home = tempfile::tempdir().unwrap();
        let m = manifest().unwrap();
        let entry = &m.skills[1];
        install_at(home.path(), &[entry.name.clone()], false);
        let dest = home.path().join(".claude/skills").join(&entry.name);
        let changed = dest.join("SKILL.md");
        fs::write(&changed, b"owner edit\n").unwrap();
        fs::write(cli_path(home.path()), b"old cli\n").unwrap();
        assert_eq!(state(&dest, entry, &m.pack_version), "locally-modified");
        let result = install_at(home.path(), &names(), false);
        assert!(!result.errors.is_empty());
        assert!(result.installed.is_empty() && result.backups.is_empty());
        assert!(!home
            .path()
            .join(".claude/skills")
            .join(&m.skills[0].name)
            .exists());
        assert_eq!(read(&cli_path(home.path())).unwrap(), b"old cli\n");
        assert_eq!(read(&changed).unwrap(), b"owner edit\n");
        let forced = install_at(home.path(), &names(), true);
        assert!(forced.errors.is_empty(), "{forced:?}");
        assert_eq!(forced.backups.len(), 2);
        assert!(forced.backups.iter().all(|p| p.contains(".bak-")));
        assert_eq!(
            read(&Path::new(&forced.backups[0]).join("SKILL.md")).unwrap(),
            b"owner edit\n"
        );
        assert_eq!(read(Path::new(&forced.backups[1])).unwrap(), b"old cli\n");
        assert_eq!(state(&dest, entry, &m.pack_version), "latest");
    }
    #[test]
    fn older_marker_is_outdated_and_update_backs_up_without_force() {
        let home = tempfile::tempdir().unwrap();
        install(home.path());
        let m = manifest().unwrap();
        let entry = &m.skills[0];
        let dest = home.path().join(".claude/skills").join(&entry.name);
        let path = dest.join(MARKER);
        let mut value: Value = serde_json::from_slice(&read(&path).unwrap()).unwrap();
        value["pack_version"] = json!("0.0.0");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(state(&dest, entry, &m.pack_version), "outdated");
        let updated = install(home.path());
        assert_eq!(updated.installed, vec![entry.name.clone()]);
        assert_eq!(updated.backups.len(), 1);
    }
    #[test]
    fn normalization_preserves_binary_and_bom_hash_but_rejects_invalid_text_writes() {
        for ext in [
            "py", "md", "json", "txt", "yaml", "yml", "sh", "ps1", "toml", "cfg", "ini", "PY",
        ] {
            let path = PathBuf::from(format!("file.{ext}"));
            assert_eq!(normalized_bytes(&path, b"a\r\nb\rc\n"), b"a\nb\nc\n");
        }
        assert_eq!(
            normalized_bytes(Path::new("file.bin"), b"a\r\nb"),
            b"a\r\nb"
        );
        assert_eq!(
            normalized_bytes(Path::new("file.py"), b"\xef\xbb\xbfhi\r\n"),
            b"\xef\xbb\xbfhi\n"
        );
        for bad in [b"\xef\xbb\xbfhi".as_slice(), b"\xef\xbf\xbd", b"\xff"] {
            assert!(canonical_write_bytes(Path::new("file.py"), bad).is_err());
        }
    }
    #[test]
    fn crlf_is_latest_and_reinstalled_as_lf_including_cli_and_marker() {
        let home = tempfile::tempdir().unwrap();
        install(home.path());
        let m = manifest().unwrap();
        let entry = &m.skills[0];
        let dest = home.path().join(".claude/skills").join(&entry.name);
        for path in [
            dest.join("SKILL.md"),
            dest.join(MARKER),
            cli_path(home.path()),
        ] {
            let bytes = read(&path).unwrap();
            let text = String::from_utf8(bytes).unwrap().replace('\n', "\r\n");
            fs::write(&path, text).unwrap();
        }
        assert_eq!(state(&dest, entry, &m.pack_version), "latest");
        assert_eq!(cli_state(home.path(), &m).unwrap(), "latest");
        assert_eq!(install(home.path()).skipped.len(), 4);
        for path in [
            dest.join("SKILL.md"),
            dest.join(MARKER),
            cli_path(home.path()),
        ] {
            assert!(!read(&path).unwrap().contains(&b'\r'));
        }
    }
    #[test]
    fn excluded_artifacts_do_not_count_but_extra_file_and_bad_marker_do() {
        let home = tempfile::tempdir().unwrap();
        install(home.path());
        let m = manifest().unwrap();
        let entry = &m.skills[0];
        let dest = home.path().join(".claude/skills").join(&entry.name);
        for part in [
            "__pycache__",
            ".pytest_cache",
            "x.pyc",
            "x.bak-123",
            "_backup123",
            "_prev",
        ] {
            fs::write(dest.join(part), b"ignored").unwrap();
        }
        assert_eq!(state(&dest, entry, &m.pack_version), "latest");
        fs::write(dest.join("extra.txt"), b"owner").unwrap();
        assert_eq!(state(&dest, entry, &m.pack_version), "locally-modified");
        fs::write(dest.join(MARKER), b"null").unwrap();
        assert_eq!(state(&dest, entry, &m.pack_version), "locally-modified");
    }
    #[test]
    fn invalid_selection_is_read_only() {
        let home = tempfile::tempdir().unwrap();
        for selection in [
            vec!["../escape".into()],
            vec![names()[0].clone(), names()[0].clone()],
        ] {
            assert!(!install_at(home.path(), &selection, true).errors.is_empty());
            assert_eq!(fs::read_dir(home.path()).unwrap().count(), 0);
        }
    }
    #[test]
    fn symlink_destinations_and_ancestors_are_rejected_before_any_write() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let parent = home.path().join(".claude/skills");
        fs::create_dir_all(&parent).unwrap();
        let dest = parent.join(&names()[1]);
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), &dest).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &dest).unwrap();
        for force in [false, true] {
            let result = install_at(home.path(), &names(), force);
            assert!(
                result.errors.iter().any(|e| e.contains("symlink")),
                "{result:?}"
            );
            assert!(result.installed.is_empty());
            assert!(!cli_path(home.path()).exists());
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        }
        let other = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), other.path().join(".mycmux")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), other.path().join(".mycmux")).unwrap();
        assert!(!install_at(other.path(), &names(), false).errors.is_empty());
        assert!(!other.path().join(".claude").exists());
    }
}
