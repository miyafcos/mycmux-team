fn write_json_atomic(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Manifest parent directory not found".to_string())?;
    let json = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create temporary manifest: {error}"))?;
    temp.write_all(json.as_bytes())
        .map_err(|error| format!("Failed to write temporary manifest: {error}"))?;
    temp.flush()
        .map_err(|error| format!("Failed to flush temporary manifest: {error}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync temporary manifest: {error}"))?;
    temp.persist(path)
        .map(|_| ())
        .map_err(|error| format!("Failed to replace {}: {}", path.display(), error.error))
}

fn lifecycle_from_value(manifest: &serde_json::Value) -> SavepointLifecycle {
    manifest
        .get("lifecycle")
        .and_then(|value| serde_json::from_value::<SavepointLifecycle>(value.clone()).ok())
        .unwrap_or_default()
        .normalized()
}

fn find_closed_head(online_dir: &Path, checkpoint_id: &str) -> Option<PathBuf> {
    let online_root = fs::canonicalize(online_dir).ok()?;
    fs::read_dir(&online_root)
        .ok()?
        .flatten()
        .find_map(|entry| {
            let candidate = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || name == FINAL_RECORDS_DIR
                || !candidate.is_dir()
                || is_link_or_reparse_point(&candidate)
            {
                return None;
            }
            let head = fs::canonicalize(&candidate).ok()?;
            if head.parent() != Some(online_root.as_path()) {
                return None;
            }
            let manifest = read_json::<serde_json::Value>(&head.join("manifest.json")).ok()?;
            let lifecycle = lifecycle_from_value(&manifest);
            (lifecycle.status == SavepointLifecycleStatus::Closed
                && !lifecycle.final_checkpoint
                && lifecycle.checkpoint_id.as_deref() == Some(checkpoint_id))
            .then_some(head)
        })
}

fn final_shadow_for_bundle(bundle_dir: &Path, manifest: &serde_json::Value) -> Option<PathBuf> {
    let lifecycle = lifecycle_from_value(manifest);
    if !lifecycle.final_checkpoint {
        return None;
    }
    let records_dir = bundle_dir.parent()?;
    if records_dir.file_name()?.to_string_lossy() != FINAL_RECORDS_DIR {
        return None;
    }
    find_closed_head(records_dir.parent()?, lifecycle.checkpoint_id.as_deref()?)
}

fn toggle_savepoint_pin_at(bundle_dir: &Path) -> Result<ToggleSavepointPinResult, String> {
    let bundle_dir = fs::canonicalize(absolute_path(bundle_dir.to_path_buf())?)
        .map_err(|error| format!("Failed to resolve {}: {error}", bundle_dir.display()))?;
    let manifest_path = bundle_dir.join("manifest.json");
    let mut manifest: serde_json::Value = read_json(&manifest_path)?;
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", manifest_path.display()))?;
    let pinned = !object
        .get("pinned")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    object.insert("pinned".to_string(), serde_json::Value::Bool(pinned));
    if let Some(shadow_dir) = final_shadow_for_bundle(&bundle_dir, &manifest) {
        let shadow_manifest_path = shadow_dir.join("manifest.json");
        let mut shadow_manifest: serde_json::Value = read_json(&shadow_manifest_path)?;
        let shadow_object = shadow_manifest.as_object_mut().ok_or_else(|| {
            format!(
                "Invalid manifest object: {}",
                shadow_manifest_path.display()
            )
        })?;
        shadow_object.insert("pinned".to_string(), serde_json::Value::Bool(pinned));
        write_json_atomic(&shadow_manifest_path, &shadow_manifest)?;
    }
    write_json_atomic(&manifest_path, &manifest)?;
    Ok(ToggleSavepointPinResult { pinned })
}

fn read_valid_manifest_for_operation(
    bundle_dir: &Path,
) -> Result<(serde_json::Value, SavepointManifest), String> {
    let manifest_path = bundle_dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(format!(
            "Savepoint manifest not found: {}",
            manifest_path.display()
        ));
    }
    let value: serde_json::Value = read_json(&manifest_path)?;
    let manifest = serde_json::from_value::<SavepointManifest>(value.clone()).map_err(|error| {
        format!(
            "Invalid savepoint manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    if manifest.schema != SAVEPOINT_SCHEMA || manifest.identity().is_err() {
        return Err(format!(
            "Invalid savepoint manifest: {}",
            manifest_path.display()
        ));
    }
    Ok((value, manifest))
}

fn validated_final_checkpoint_id(
    manifest: &SavepointManifest,
    original_parent: SavepointTrashParent,
    original_name: &str,
) -> Result<Option<String>, String> {
    let lifecycle = manifest.lifecycle.clone().normalized();
    if !lifecycle.final_checkpoint {
        return Ok(None);
    }
    if original_parent == SavepointTrashParent::Root {
        let received_transfer_id = manifest.transfer.as_ref().and_then(|transfer| {
            Uuid::parse_str(&transfer.id)
                .ok()
                .map(|id| format!("received_{id}"))
        });
        if received_transfer_id.as_deref() == Some(original_name) {
            // Received final checkpoints have no local closed-head shadow and keep
            // their transfer-stable root name so importing the same file is idempotent.
            return Ok(None);
        }
    }
    let checkpoint_id = lifecycle
        .checkpoint_id
        .filter(|value| Uuid::parse_str(value).is_ok())
        .ok_or_else(|| "Final savepoint checkpoint id is invalid".to_string())?;
    if original_parent != SavepointTrashParent::Records || original_name != checkpoint_id {
        return Err("Final savepoint identity does not match its records path".to_string());
    }
    Ok(Some(checkpoint_id))
}

fn matching_closed_head(
    online_root: &Path,
    checkpoint_id: &str,
    identity: &SavepointIdentity,
) -> Result<Option<(PathBuf, serde_json::Value)>, String> {
    let Some(shadow_dir) = find_closed_head(online_root, checkpoint_id) else {
        return Ok(None);
    };
    let (shadow_value, shadow_manifest) = read_valid_manifest_for_operation(&shadow_dir)?;
    if shadow_manifest.identity()? != *identity {
        return Err("Final savepoint shadow belongs to a different session".to_string());
    }
    Ok(Some((shadow_dir, shadow_value)))
}

fn update_final_shadow_trash_marker(
    online_root: &Path,
    manifest: &SavepointManifest,
    original_parent: SavepointTrashParent,
    original_name: &str,
    checkpoint_marker: Option<&str>,
) -> Result<Option<(PathBuf, serde_json::Value)>, String> {
    let Some(checkpoint_id) =
        validated_final_checkpoint_id(manifest, original_parent, original_name)?
    else {
        return Ok(None);
    };
    let identity = manifest.identity()?;
    let Some((shadow_dir, original_shadow)) =
        matching_closed_head(online_root, &checkpoint_id, &identity)?
    else {
        return Ok(None);
    };
    let mut updated_shadow = original_shadow.clone();
    let shadow_object = updated_shadow
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", shadow_dir.display()))?;
    if let Some(marker) = checkpoint_marker {
        shadow_object.insert(
            TRASHED_FINAL_CHECKPOINT_FIELD.to_string(),
            serde_json::Value::String(marker.to_string()),
        );
    } else {
        shadow_object.remove(TRASHED_FINAL_CHECKPOINT_FIELD);
    }
    write_json_atomic(&shadow_dir.join("manifest.json"), &updated_shadow)?;
    Ok(Some((shadow_dir, original_shadow)))
}

fn resolve_active_savepoint(
    online_dir: &Path,
    bundle_dir: &Path,
) -> Result<
    (
        PathBuf,
        PathBuf,
        serde_json::Value,
        SavepointManifest,
        SavepointTrashParent,
    ),
    String,
> {
    let online_root = fs::canonicalize(online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    if is_link_or_reparse_point(bundle_dir) {
        return Err("Savepoint links cannot be moved to the trash".to_string());
    }
    let bundle_dir = fs::canonicalize(bundle_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", bundle_dir.display()))?;
    let name = bundle_dir
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| "Savepoint bundle name is missing".to_string())?;
    if name == FINAL_RECORDS_DIR || name == TRASH_DIR || !is_safe_path_component(&name) {
        return Err("Savepoint containers cannot be moved to the trash".to_string());
    }
    let original_parent = if bundle_dir.parent() == Some(online_root.as_path()) {
        SavepointTrashParent::Root
    } else if bundle_dir.parent().is_some_and(|parent| {
        parent
            .file_name()
            .is_some_and(|value| value.to_string_lossy() == FINAL_RECORDS_DIR)
            && parent.parent() == Some(online_root.as_path())
    }) {
        SavepointTrashParent::Records
    } else {
        return Err(format!(
            "Savepoint bundle must be inside {}",
            online_root.display()
        ));
    };
    let (manifest_value, manifest) = read_valid_manifest_for_operation(&bundle_dir)?;
    Ok((
        online_root,
        bundle_dir,
        manifest_value,
        manifest,
        original_parent,
    ))
}

fn ensure_trash_root(online_root: &Path) -> Result<PathBuf, String> {
    let trash_dir = online_root.join(TRASH_DIR);
    if !trash_dir.exists() {
        fs::create_dir(&trash_dir)
            .map_err(|error| format!("Failed to create {}: {error}", trash_dir.display()))?;
    }
    if !trash_dir.is_dir() || is_link_or_reparse_point(&trash_dir) {
        return Err(format!(
            "Invalid savepoint trash directory: {}",
            trash_dir.display()
        ));
    }
    let trash_root = fs::canonicalize(&trash_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", trash_dir.display()))?;
    if trash_root.parent() != Some(online_root) {
        return Err(format!(
            "Invalid savepoint trash directory: {}",
            trash_dir.display()
        ));
    }
    Ok(trash_root)
}

fn trash_online_savepoint_at(
    online_dir: &Path,
    bundle_dir: &Path,
    deleted_at: &str,
    reason: SavepointTrashReason,
) -> Result<PathBuf, String> {
    let (online_root, bundle_dir, original_manifest, manifest, original_parent) =
        resolve_active_savepoint(online_dir, bundle_dir)?;
    let original_name = bundle_dir
        .file_name()
        .expect("validated savepoint name")
        .to_string_lossy()
        .into_owned();
    let trash_root = ensure_trash_root(&online_root)?;
    let trash_id = Uuid::new_v4().to_string();
    let target = trash_root.join(&trash_id);
    let trash = SavepointTrash {
        id: trash_id,
        deleted_at: deleted_at.to_string(),
        reason,
        original_parent,
        original_name: original_name.clone(),
    };
    let final_checkpoint_id =
        validated_final_checkpoint_id(&manifest, original_parent, &original_name)?;
    let shadow_rollback = update_final_shadow_trash_marker(
        &online_root,
        &manifest,
        original_parent,
        &original_name,
        final_checkpoint_id.as_deref(),
    )?;
    let mut updated_manifest = original_manifest.clone();
    updated_manifest
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", bundle_dir.display()))?
        .insert(
            "trash".to_string(),
            serde_json::to_value(trash)
                .map_err(|error| format!("Failed to serialize trash metadata: {error}"))?,
        );
    if let Err(error) = write_json_atomic(&bundle_dir.join("manifest.json"), &updated_manifest) {
        if let Some((shadow_dir, original_shadow)) = shadow_rollback.as_ref() {
            let _ = write_json_atomic(&shadow_dir.join("manifest.json"), original_shadow);
        }
        return Err(error);
    }
    if let Err(error) = fs::rename(&bundle_dir, &target) {
        let _ = write_json_atomic(&bundle_dir.join("manifest.json"), &original_manifest);
        if let Some((shadow_dir, original_shadow)) = shadow_rollback.as_ref() {
            let _ = write_json_atomic(&shadow_dir.join("manifest.json"), original_shadow);
        }
        return Err(format!(
            "Failed to move {} to {}: {error}",
            bundle_dir.display(),
            target.display()
        ));
    }
    Ok(target)
}

fn resolve_trashed_savepoint(
    online_dir: &Path,
    bundle_dir: &Path,
    expected_trash_id: &str,
) -> Result<
    (
        PathBuf,
        PathBuf,
        serde_json::Value,
        SavepointManifest,
        SavepointTrash,
    ),
    String,
> {
    let online_root = fs::canonicalize(online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    if Uuid::parse_str(expected_trash_id).is_err() || is_link_or_reparse_point(bundle_dir) {
        return Err("Invalid savepoint trash item".to_string());
    }
    let trash_dir = online_root.join(TRASH_DIR);
    if !trash_dir.is_dir() || is_link_or_reparse_point(&trash_dir) {
        return Err("Savepoint trash directory was not found".to_string());
    }
    let trash_root = fs::canonicalize(&trash_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", trash_dir.display()))?;
    if trash_root.parent() != Some(online_root.as_path()) {
        return Err(format!(
            "Invalid savepoint trash directory: {}",
            trash_dir.display()
        ));
    }
    let bundle_dir = fs::canonicalize(bundle_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", bundle_dir.display()))?;
    if bundle_dir.parent() != Some(trash_root.as_path())
        || bundle_dir
            .file_name()
            .is_none_or(|value| value.to_string_lossy() != expected_trash_id)
    {
        return Err("Savepoint trash item does not match the requested id".to_string());
    }
    let (manifest_value, manifest) = read_valid_manifest_for_operation(&bundle_dir)?;
    let trash = manifest
        .trash
        .clone()
        .filter(|trash| {
            trash.id == expected_trash_id && is_safe_path_component(&trash.original_name)
        })
        .ok_or_else(|| "Savepoint trash metadata does not match the requested id".to_string())?;
    Ok((online_root, bundle_dir, manifest_value, manifest, trash))
}

fn restore_online_savepoint_at(
    online_dir: &Path,
    bundle_dir: &Path,
    trash_id: &str,
) -> Result<PathBuf, String> {
    let (online_root, bundle_dir, original_manifest, manifest, trash) =
        resolve_trashed_savepoint(online_dir, bundle_dir, trash_id)?;
    let target_parent = match trash.original_parent {
        SavepointTrashParent::Root => online_root.clone(),
        SavepointTrashParent::Records => {
            let records_dir = online_root.join(FINAL_RECORDS_DIR);
            if !records_dir.exists() {
                fs::create_dir(&records_dir).map_err(|error| {
                    format!("Failed to create {}: {error}", records_dir.display())
                })?;
            }
            if !records_dir.is_dir() || is_link_or_reparse_point(&records_dir) {
                return Err(format!(
                    "Invalid final-records directory: {}",
                    records_dir.display()
                ));
            }
            let records_root = fs::canonicalize(&records_dir)
                .map_err(|error| format!("Failed to resolve {}: {error}", records_dir.display()))?;
            if records_root.parent() != Some(online_root.as_path()) {
                return Err(format!(
                    "Invalid final-records directory: {}",
                    records_dir.display()
                ));
            }
            records_root
        }
    };
    let target = target_parent.join(&trash.original_name);
    if target.exists() {
        return Err(format!(
            "A savepoint already exists at the restore destination: {}",
            target.display()
        ));
    }
    let shadow_rollback = update_final_shadow_trash_marker(
        &online_root,
        &manifest,
        trash.original_parent,
        &trash.original_name,
        None,
    )?;
    let mut restored_manifest = original_manifest;
    let restored_object = restored_manifest
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", bundle_dir.display()))?;
    restored_object.remove("trash");
    restored_object.insert(
        "expires_at".to_string(),
        serde_json::Value::String(
            (Utc::now() + chrono::Duration::hours(RESTORED_EXPIRE_HOURS)).to_rfc3339(),
        ),
    );
    if let Err(error) = fs::rename(&bundle_dir, &target) {
        if let Some((shadow_dir, original_shadow)) = shadow_rollback.as_ref() {
            let _ = write_json_atomic(&shadow_dir.join("manifest.json"), original_shadow);
        }
        return Err(format!(
            "Failed to restore {} to {}: {error}",
            bundle_dir.display(),
            target.display()
        ));
    }
    if let Err(error) = write_json_atomic(&target.join("manifest.json"), &restored_manifest) {
        let _ = fs::rename(&target, &bundle_dir);
        if let Some((shadow_dir, original_shadow)) = shadow_rollback.as_ref() {
            let _ = write_json_atomic(&shadow_dir.join("manifest.json"), original_shadow);
        }
        return Err(error);
    }
    Ok(target)
}

fn purge_online_savepoint_at(
    online_dir: &Path,
    bundle_dir: &Path,
    trash_id: &str,
) -> Result<(), String> {
    let (online_root, bundle_dir, _manifest_value, manifest, trash) =
        resolve_trashed_savepoint(online_dir, bundle_dir, trash_id)?;
    if let Some(checkpoint_id) =
        validated_final_checkpoint_id(&manifest, trash.original_parent, &trash.original_name)?
    {
        let active_final_path = online_root.join(FINAL_RECORDS_DIR).join(&checkpoint_id);
        match fs::symlink_metadata(&active_final_path) {
            Ok(_) => {
                return Err(format!(
                    "A live final savepoint still exists at {}",
                    active_final_path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to verify {}: {error}",
                    active_final_path.display()
                ));
            }
        }
        let identity = manifest.identity()?;
        if let Some((shadow_dir, shadow_manifest)) =
            matching_closed_head(&online_root, &checkpoint_id, &identity)?
        {
            if shadow_manifest
                .get(TRASHED_FINAL_CHECKPOINT_FIELD)
                .and_then(|value| value.as_str())
                != Some(checkpoint_id.as_str())
            {
                return Err("Final savepoint shadow is not marked for this trash entry".to_string());
            }
            fs::remove_dir_all(&shadow_dir)
                .map_err(|error| format!("Failed to delete {}: {error}", shadow_dir.display()))?;
        }
    }
    fs::remove_dir_all(&bundle_dir)
        .map_err(|error| format!("Failed to delete {}: {error}", bundle_dir.display()))
}

fn parse_iso_datetime(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(parsed.with_timezone(&Utc));
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .and_then(|parsed| Local.from_local_datetime(&parsed).single())
        .map(|parsed| parsed.with_timezone(&Utc))
}

fn cleanup_online_savepoints_from_config(
    config_path: &Path,
    home: &Path,
    now: DateTime<Utc>,
    now_system: SystemTime,
) -> Result<CleanupOnlineSavepointsResult, String> {
    let _publish_guard = super::online_publish::PUBLISH_LOCK
        .lock()
        .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
    let config = load_config(config_path)?;
    let online_dir = local_savepoint_dir(&config, home)?;
    let machine = config
        .machine
        .filter(|value| !value.is_empty())
        .or_else(sysinfo::System::host_name)
        .unwrap_or_default();
    let mut result = CleanupOnlineSavepointsResult {
        online_dir: online_dir.to_string_lossy().into_owned(),
        machine,
        deleted_count: 0,
        expired_count: 0,
        stale_count: 0,
        kept_count: 0,
    };
    if !online_dir.is_dir() {
        return Ok(result);
    }

    let online_root = fs::canonicalize(&online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    let deleted_at = now.to_rfc3339();
    let mut scan_roots = vec![online_root.clone()];
    let final_records_dir = online_root.join(FINAL_RECORDS_DIR);
    if final_records_dir.is_dir() && !is_link_or_reparse_point(&final_records_dir) {
        if let Ok(final_records_root) = fs::canonicalize(&final_records_dir) {
            if final_records_root.parent() == Some(online_root.as_path()) {
                scan_roots.push(final_records_root);
            }
        }
    }
    for scan_root in scan_roots {
        let entries = fs::read_dir(&scan_root)
            .map_err(|error| format!("Failed to scan {}: {error}", scan_root.display()))?;
        for entry in entries.flatten() {
            let candidate = entry.path();
            if !candidate.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if scan_root == online_root && (name == FINAL_RECORDS_DIR || name == TRASH_DIR) {
                continue;
            }
            if is_link_or_reparse_point(&candidate) {
                result.kept_count += 1;
                continue;
            }
            let Ok(path) = fs::canonicalize(&candidate) else {
                result.kept_count += 1;
                continue;
            };
            if path.parent() != Some(scan_root.as_path()) {
                result.kept_count += 1;
                continue;
            }
            if path == final_records_dir {
                result.kept_count += 1;
                continue;
            }
            if is_generated_publish_artifact_name(&name) && has_valid_savepoint_manifest(&path) {
                let stale = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| now_system.duration_since(modified).ok())
                    .is_some_and(|age| age > Duration::from_secs(STALE_TMP_SECONDS));
                if stale {
                    if fs::remove_dir_all(&path).is_ok() {
                        result.deleted_count += 1;
                        result.stale_count += 1;
                    } else {
                        result.kept_count += 1;
                    }
                } else {
                    result.kept_count += 1;
                }
                continue;
            }

            let Ok(manifest) = read_json::<SavepointManifest>(&path.join("manifest.json")) else {
                result.kept_count += 1;
                continue;
            };
            if manifest.schema != SAVEPOINT_SCHEMA
                || manifest.pinned
                || (manifest.lifecycle.status == SavepointLifecycleStatus::Closed
                    && !manifest.lifecycle.final_checkpoint)
            {
                result.kept_count += 1;
                continue;
            }
            let Some(expires_at) = parse_iso_datetime(&manifest.expires_at) else {
                result.kept_count += 1;
                continue;
            };
            if expires_at < now {
                if trash_online_savepoint_at(
                    &online_root,
                    &path,
                    &deleted_at,
                    SavepointTrashReason::Expired,
                )
                .is_ok()
                {
                    result.deleted_count += 1;
                    result.expired_count += 1;
                } else {
                    result.kept_count += 1;
                }
            } else {
                result.kept_count += 1;
            }
        }
    }
    Ok(result)
}
