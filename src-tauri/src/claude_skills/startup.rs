use super::{install, manifest, Manifest, PACK_CLI};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum UpdateState {
    Updated,
    Latest,
    LocallyModified,
    Unmanaged,
    NotInstalled,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct StartupUpdate {
    state: UpdateState,
    message: String,
    backup: Option<String>,
}

impl StartupUpdate {
    fn notice(state: UpdateState, message: impl Into<String>) -> Self {
        Self {
            state,
            message: message.into(),
            backup: None,
        }
    }
}

static LAST_UPDATE: OnceLock<StartupUpdate> = OnceLock::new();

pub(super) fn last_update() -> Option<StartupUpdate> {
    LAST_UPDATE.get().cloned()
}

// Called once from primary-instance setup, before the control API starts.
// Test profiles never call this function or touch the real installed CLI.
pub(super) fn run() {
    LAST_UPDATE.get_or_init(|| {
        let result = (|| {
            let home = dirs::home_dir().ok_or("home directory is not available")?;
            attempt_at(&home, &manifest()?)
        })();
        let update = outcome(result);
        crate::diag::log(&format!("[claude_skills] {}", update.message));
        update
    });
}

fn outcome(result: Result<StartupUpdate, String>) -> StartupUpdate {
    result.unwrap_or_else(|error| {
        StartupUpdate::notice(
            UpdateState::Error,
            format!("起動時の制御 API の CLI 自動更新を見送りました: {error}"),
        )
    })
}

fn has_install_marker(home: &Path, manifest: &Manifest) -> Result<bool, String> {
    #[derive(Deserialize)]
    struct Marker {
        pack_version: String,
        sha256: BTreeMap<String, String>,
        installed_at: String,
    }
    for entry in &manifest.skills {
        let path = home
            .join(".claude/skills")
            .join(&entry.name)
            .join(install::MARKER);
        install::reject_symlinks(home, &path)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("{}: {error}", path.display())),
            Ok(metadata) if !metadata.is_file() => {
                return Err(format!(
                    "installation marker is not a regular file: {}",
                    path.display()
                ));
            }
            Ok(_) => (),
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        let Ok(marker) = serde_json::from_slice::<Marker>(&bytes) else {
            continue;
        };
        if !marker.pack_version.is_empty()
            && !marker.sha256.is_empty()
            && marker
                .sha256
                .values()
                .all(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            && chrono::DateTime::parse_from_rfc3339(&marker.installed_at).is_ok()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn attempt_at(home: &Path, manifest: &Manifest) -> Result<StartupUpdate, String> {
    let path = install::cli_path(home);
    install::reject_symlinks(home, &path)?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StartupUpdate::notice(
                UpdateState::NotInstalled,
                "制御 API の CLI の置き場所がないため、起動時の自動更新は行いませんでした。設定の「導入」から導入できます。",
            ));
        }
        Err(error) => return Err(format!("{}: {error}", path.display())),
        Ok(metadata) if !metadata.is_file() => {
            return Err(format!(
                "CLI destination is not a regular file: {}",
                path.display()
            ));
        }
        Ok(_) => (),
    }
    if !has_install_marker(home, manifest)? {
        return Ok(StartupUpdate::notice(
            UpdateState::Unmanaged,
            "制御 API の CLI の導入記録がないか壊れているため、起動時の自動更新を見送りました。設定から確認してください。",
        ));
    }
    let old = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let hash = install::sha(&path, &old);
    if hash == manifest.cli.sha256 {
        return Ok(StartupUpdate::notice(
            UpdateState::Latest,
            "制御 API の CLI は同梱の最新版です。",
        ));
    }
    if !manifest.cli.known_sha256.contains(&hash) {
        return Ok(StartupUpdate::notice(
            UpdateState::LocallyModified,
            "制御 API の CLI はローカル改変または未確認の版のため、起動時の自動更新を見送りました。設定から確認してください。",
        ));
    }
    install::validate_pack(manifest)?;
    let backup = replace_cli(home, &path, &old, PACK_CLI, || {
        if has_install_marker(home, manifest)? {
            Ok(())
        } else {
            Err("installation marker changed during startup".into())
        }
    })?;
    Ok(StartupUpdate {
        state: UpdateState::Updated,
        message: format!(
            "起動時に制御 API の CLI を同梱の最新版へ更新しました。旧版の控え: {}",
            backup.file_name().unwrap_or_default().to_string_lossy()
        ),
        backup: Some(backup.to_string_lossy().into_owned()),
    })
}

fn staged_file(
    path: &Path,
    bytes: &[u8],
    permissions: fs::Permissions,
) -> Result<tempfile::NamedTempFile, String> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("missing parent")?)
        .map_err(|e| format!("stage {}: {e}", path.display()))?;
    temp.write_all(bytes)
        .and_then(|_| temp.flush())
        .map_err(|e| format!("stage {}: {e}", path.display()))?;
    temp.as_file()
        .set_permissions(permissions)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| format!("sync {}: {e}", path.display()))?;
    if fs::read(temp.path()).map_err(|e| e.to_string())? != bytes {
        return Err(format!(
            "staged write verification failed: {}",
            path.display()
        ));
    }
    Ok(temp)
}

fn save_backup(path: &Path, bytes: &[u8], permissions: fs::Permissions) -> Result<(), String> {
    // persist_noclobber also refuses a pre-existing file or symlink. The
    // backup becomes visible only after its complete bytes are synced.
    staged_file(path, bytes, permissions)?
        .persist_noclobber(path)
        .map(|_| ())
        .map_err(|e| format!("backup {}: {}", path.display(), e.error))
}

fn replace_cli(
    home: &Path,
    path: &Path,
    old: &[u8],
    payload: &[u8],
    check_ownership: impl FnOnce() -> Result<(), String>,
) -> Result<PathBuf, String> {
    install::reject_symlinks(home, path)?;
    let bytes = install::canonical_write_bytes(path, payload)?;
    let permissions = fs::metadata(path)
        .map_err(|e| e.to_string())?
        .permissions();
    if permissions.readonly() {
        return Err(format!("CLI destination is read-only: {}", path.display()));
    }
    let temp = staged_file(path, &bytes, permissions.clone())?;
    let backup = install::backup_path(path)?;
    save_backup(&backup, old, permissions)?;
    let commit = (|| {
        check_ownership()?;
        install::reject_symlinks(home, path)?;
        if fs::read(path).map_err(|e| e.to_string())? != old {
            return Err(
                "CLI changed during startup; leaving the changed file in place".into()
            );
        }
        // No gap at the live path: its old file stays readable until this
        // same-directory atomic rename. Failed staging/rename drops the temp.
        temp.persist(path)
            .map(|_| ())
            .map_err(|e| format!("replace CLI atomically: {}", e.error))
    })();
    commit.map_err(|error| format!("{error}; backup retained: {}", backup.display()))?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const OLD: &[u8] = b"# previous distributed CLI\nprint('previous')\n";

    fn previous_manifest() -> Manifest {
        let mut m = manifest().unwrap();
        m.cli.known_sha256.push(install::sha(Path::new("cli.py"), OLD));
        m.cli.known_sha256.sort();
        m.cli.known_sha256.dedup();
        m
    }
    fn marker_path(home: &Path, m: &Manifest) -> PathBuf {
        home.join(".claude/skills").join(&m.skills[0].name).join(install::MARKER)
    }
    fn managed(home: &Path, m: &Manifest, bytes: &[u8]) -> PathBuf {
        let marker = marker_path(home, m);
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(&marker, serde_json::to_vec(&json!({
            "pack_version": "1.0.0", "sha256": m.skills[0].files,
            "installed_at": "2026-09-15T01:02:03+00:00"
        })).unwrap()).unwrap();
        let cli = install::cli_path(home);
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, bytes).unwrap();
        cli
    }
    fn update(home: &Path, m: &Manifest) -> StartupUpdate { outcome(attempt_at(home, m)) }
    fn bin_entries(path: &Path) -> usize { fs::read_dir(path.parent().unwrap()).unwrap().count() }

    #[test]
    fn known_previous_cli_is_replaced_atomically_with_exact_backup_then_noop() {
        let home = tempfile::tempdir().unwrap();
        let m = previous_manifest();
        let cli = managed(home.path(), &m, OLD);
        let marker = marker_path(home.path(), &m);
        let marker_bytes = fs::read(&marker).unwrap();
        let permissions = fs::metadata(&cli).unwrap().permissions();
        let result = update(home.path(), &m);
        assert_eq!(result.state, UpdateState::Updated, "{result:?}");
        assert_eq!(
            fs::read(&cli).unwrap(),
            install::canonical_write_bytes(&cli, PACK_CLI).unwrap()
        );
        assert_eq!(fs::read(result.backup.unwrap()).unwrap(), OLD);
        assert_eq!(fs::read(&marker).unwrap(), marker_bytes);
        assert_eq!(bin_entries(&cli), 2);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&cli).unwrap().permissions().mode(), permissions.mode());
        }
        let modified = fs::metadata(&cli).unwrap().modified().unwrap();
        assert_eq!(update(home.path(), &m).state, UpdateState::Latest);
        assert_eq!(fs::metadata(&cli).unwrap().modified().unwrap(), modified);
        assert_eq!(bin_entries(&cli), 2);
    }
    #[test]
    fn owner_edited_or_unknown_cli_is_preserved_and_reported() {
        let home = tempfile::tempdir().unwrap();
        let m = previous_manifest();
        let cli = managed(home.path(), &m, b"# owner edit\n");
        let result = update(home.path(), &m);
        assert_eq!(result.state, UpdateState::LocallyModified);
        assert!(result.message.contains("ローカル改変"));
        assert_eq!(fs::read(&cli).unwrap(), b"# owner edit\n");
        assert_eq!(bin_entries(&cli), 1);
    }
    #[test]
    fn missing_marker_does_not_update_or_create_skill_directories() {
        let home = tempfile::tempdir().unwrap();
        let cli = install::cli_path(home.path());
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, OLD).unwrap();
        assert_eq!(update(home.path(), &previous_manifest()).state, UpdateState::Unmanaged);
        assert_eq!(fs::read(&cli).unwrap(), OLD);
        assert_eq!(bin_entries(&cli), 1);
        assert!(!home.path().join(".claude").exists());
    }
    #[test]
    fn malformed_marker_is_not_an_installation_record() {
        let home = tempfile::tempdir().unwrap();
        let m = previous_manifest();
        let cli = managed(home.path(), &m, OLD);
        for invalid in [b"null".as_slice(), b"{}", b"{broken"] {
            fs::write(marker_path(home.path(), &m), invalid).unwrap();
            assert_eq!(update(home.path(), &m).state, UpdateState::Unmanaged);
            assert_eq!(fs::read(&cli).unwrap(), OLD);
            assert_eq!(bin_entries(&cli), 1);
        }
    }
    #[test]
    fn missing_cli_or_bin_directory_is_not_created() {
        let m = previous_manifest();
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(update(empty.path(), &m).state, UpdateState::NotInstalled);
        assert_eq!(fs::read_dir(empty.path()).unwrap().count(), 0);
        let installed = tempfile::tempdir().unwrap();
        let cli = managed(installed.path(), &m, OLD);
        fs::remove_file(&cli).unwrap();
        assert_eq!(update(installed.path(), &m).state, UpdateState::NotInstalled);
        assert_eq!(bin_entries(&cli), 0);
        fs::remove_dir(cli.parent().unwrap()).unwrap();
        assert_eq!(update(installed.path(), &m).state, UpdateState::NotInstalled);
        assert!(!cli.parent().unwrap().exists());
    }
    #[test]
    fn crlf_previous_cli_has_exact_crlf_backup_and_lf_replacement() {
        let home = tempfile::tempdir().unwrap();
        let m = previous_manifest();
        let crlf = String::from_utf8(OLD.to_vec()).unwrap().replace('\n', "\r\n");
        let cli = managed(home.path(), &m, crlf.as_bytes());
        let result = update(home.path(), &m);
        assert_eq!(result.state, UpdateState::Updated);
        assert_eq!(fs::read(result.backup.unwrap()).unwrap(), crlf.as_bytes());
        assert_eq!(
            fs::read(&cli).unwrap(),
            install::canonical_write_bytes(&cli, PACK_CLI).unwrap()
        );
        assert!(!fs::read(&cli).unwrap().contains(&b'\r'));
    }
    #[test]
    fn failed_precommit_keeps_live_cli_and_complete_backup_without_temp_files() {
        let home = tempfile::tempdir().unwrap();
        let cli = managed(home.path(), &previous_manifest(), OLD);
        let error = replace_cli(home.path(), &cli, OLD, PACK_CLI, || {
            assert_eq!(fs::read(&cli).unwrap(), OLD);
            Err("installation marker changed during startup".into())
        }).unwrap_err();
        assert!(error.contains("backup retained"));
        assert_eq!(fs::read(&cli).unwrap(), OLD);
        assert_eq!(bin_entries(&cli), 2);
        for entry in fs::read_dir(cli.parent().unwrap()).unwrap().flatten() {
            assert_eq!(fs::read(entry.path()).unwrap(), OLD);
        }
    }
    #[test]
    fn edit_during_staging_is_preserved_with_original_backup() {
        let home = tempfile::tempdir().unwrap();
        let cli = managed(home.path(), &previous_manifest(), OLD);
        let error = replace_cli(home.path(), &cli, OLD, PACK_CLI, || {
            fs::write(&cli, b"# late owner edit\n").unwrap();
            Ok(())
        }).unwrap_err();
        assert!(error.contains("CLI changed during startup"));
        assert_eq!(fs::read(&cli).unwrap(), b"# late owner edit\n");
        assert_eq!(bin_entries(&cli), 2);
        let backup = fs::read_dir(cli.parent().unwrap()).unwrap().flatten()
            .find(|entry| entry.path() != cli).unwrap();
        assert_eq!(fs::read(backup.path()).unwrap(), OLD);
    }
    #[test]
    fn backup_collision_is_never_overwritten() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("cli.py.bak-fixed");
        fs::write(&path, b"existing backup\n").unwrap();
        assert!(save_backup(&path, OLD, fs::metadata(&path).unwrap().permissions()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"existing backup\n");
        assert_eq!(fs::read_dir(home.path()).unwrap().count(), 1);
    }
    #[test]
    fn invalid_payload_is_rejected_before_backup_or_replacement() {
        let home = tempfile::tempdir().unwrap();
        let cli = managed(home.path(), &previous_manifest(), OLD);
        assert!(replace_cli(home.path(), &cli, OLD, b"\xef\xbb\xbfprint(1)\n", || Ok(())).is_err());
        assert_eq!(fs::read(&cli).unwrap(), OLD);
        assert_eq!(bin_entries(&cli), 1);
    }
    #[test]
    fn invalid_embedded_hash_history_does_not_replace_cli() {
        let home = tempfile::tempdir().unwrap();
        let mut m = previous_manifest();
        let cli = managed(home.path(), &m, OLD);
        m.cli.known_sha256.push("invalid".into());
        let result = update(home.path(), &m);
        assert_eq!(result.state, UpdateState::Error);
        assert!(result.message.contains("hash history"));
        assert_eq!(fs::read(&cli).unwrap(), OLD);
        assert_eq!(bin_entries(&cli), 1);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_cli_marker_and_managed_ancestor_are_never_followed() {
        use std::os::unix::fs::symlink;
        let m = previous_manifest();
        for target in ["cli", "marker", "ancestor"] {
            let home = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let cli = managed(home.path(), &m, OLD);
            let outside_cli = outside.path().join("mycmux_agent_cli.py");
            fs::write(&outside_cli, OLD).unwrap();
            let path = match target {
                "cli" => cli.clone(),
                "marker" => marker_path(home.path(), &m),
                _ => cli.parent().unwrap().to_path_buf(),
            };
            if path.is_dir() { fs::remove_file(&cli).unwrap(); fs::remove_dir(&path).unwrap(); }
            else { fs::remove_file(&path).unwrap(); }
            let link_target = if target == "ancestor" { outside.path() } else { &outside_cli };
            symlink(link_target, &path).unwrap();
            assert_eq!(update(home.path(), &m).state, UpdateState::Error, "{target}");
            assert_eq!(fs::read(&outside_cli).unwrap(), OLD);
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
        }
    }
}
