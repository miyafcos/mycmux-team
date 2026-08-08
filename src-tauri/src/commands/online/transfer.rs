use super::*;
use crate::util::atomic_write::AtomicWrite;
use crate::util::task::run_blocking;
use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const TRANSFER_FORMAT: &str = "mycmux-transfer";
const TRANSFER_SCHEMA: u32 = 1;
const TRANSFER_EXTENSION: &str = "mycmux-transfer";
const TRANSFER_ENTRY: &str = "transfer.json";
const MANIFEST_ENTRY: &str = "bundle/manifest.json";
const HANDOFF_ENTRY: &str = "bundle/handoff.md";
const TRANSCRIPT_ENTRY: &str = "bundle/transcript/session.jsonl";
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TRANSFER_BYTES: u64 = 256 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_HANDOFF_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct TransferPayload {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct TransferEnvelope {
    format: String,
    schema: u32,
    transfer_id: String,
    created_at: String,
    source_checkpoint_id: Option<String>,
    payloads: Vec<TransferPayload>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ExportSavepointTransferResult {
    path: String,
    transfer_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ImportSavepointTransferResult {
    bundle_dir: String,
    transfer_id: String,
    summary_line: String,
    imported: bool,
}

fn is_transfer_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(TRANSFER_EXTENSION))
}

fn transfer_bundle_files(
    local_dir: &Path,
    bundle_dir: &Path,
) -> Result<(PathBuf, PathBuf, PathBuf, SavepointManifest), String> {
    let (_, bundle_dir, _, manifest, _) = resolve_active_savepoint(local_dir, bundle_dir)?;
    let manifest_path = bundle_dir.join("manifest.json");
    let handoff_path = bundle_dir.join("handoff.md");
    if is_link_or_reparse_point(&manifest_path)
        || is_link_or_reparse_point(&handoff_path)
        || is_link_or_reparse_point(&bundle_dir.join("transcript"))
    {
        return Err("Savepoint transfer files must not be links or junctions".to_string());
    }
    let handoff = fs::metadata(&handoff_path)
        .map_err(|error| format!("Failed to inspect {}: {error}", handoff_path.display()))?;
    if !handoff.is_file() || handoff.len() == 0 {
        return Err("Savepoint handoff is empty".to_string());
    }
    let transcript_path = find_transcript(&bundle_dir)?;
    if is_link_or_reparse_point(&transcript_path) {
        return Err("Savepoint transcript must not be a link or junction".to_string());
    }
    let transcript_count = fs::read_dir(bundle_dir.join("transcript"))
        .map_err(|error| format!("Failed to scan savepoint transcript: {error}"))?
        .flatten()
        .filter(|entry| {
            let path = entry.path();
            path.is_file() && path.extension().is_some_and(|value| value == "jsonl")
        })
        .count();
    if transcript_count != 1 {
        return Err("Savepoint transfer requires exactly one transcript".to_string());
    }
    Ok((manifest_path, handoff_path, transcript_path, manifest))
}

fn write_zip_file(
    writer: &mut ZipWriter<&mut File>,
    archive_path: &str,
    source_path: &Path,
    options: SimpleFileOptions,
    limit: u64,
) -> Result<TransferPayload, String> {
    writer
        .start_file(archive_path, options)
        .map_err(|error| format!("Failed to add {archive_path} to transfer: {error}"))?;
    let mut source = File::open(source_path)
        .map_err(|error| format!("Failed to open {}: {error}", source_path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0_u64;
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read {}: {error}", source_path.display()))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        if bytes > limit {
            return Err(format!(
                "Savepoint transfer entry {archive_path} is too large"
            ));
        }
        hasher.update(&buffer[..read]);
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("Failed to write {archive_path}: {error}"))?;
    }
    Ok(TransferPayload {
        path: archive_path.to_string(),
        bytes,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

fn transfer_digest(envelope: &TransferEnvelope) -> String {
    let mut hasher = Sha256::new();
    for payload in &envelope.payloads {
        hasher.update(payload.path.as_bytes());
        hasher.update([0]);
        hasher.update(payload.bytes.to_le_bytes());
        hasher.update(payload.sha256.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn export_savepoint_transfer_at(
    local_dir: &Path,
    bundle_dir: &Path,
    destination_path: &Path,
) -> Result<ExportSavepointTransferResult, String> {
    if !destination_path.is_absolute() || !is_transfer_path(destination_path) {
        return Err("Transfer destination must be an absolute .mycmux-transfer path".to_string());
    }
    if destination_path
        .parent()
        .filter(|path| path.is_dir())
        .is_none()
    {
        return Err("Transfer destination folder was not found".to_string());
    }
    let (manifest_path, handoff_path, transcript_path, manifest) =
        transfer_bundle_files(local_dir, bundle_dir)?;
    let transfer_id = Uuid::new_v4().to_string();
    AtomicWrite::new("transfer file", "Failed to save transfer file")
        .parent_missing("Transfer destination folder was not found")
        .write_with(destination_path, |temp_file| {
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o600);
            let mut writer = ZipWriter::new(temp_file);
            let payloads = vec![
                write_zip_file(
                    &mut writer,
                    MANIFEST_ENTRY,
                    &manifest_path,
                    options,
                    MAX_MANIFEST_BYTES,
                )?,
                write_zip_file(
                    &mut writer,
                    HANDOFF_ENTRY,
                    &handoff_path,
                    options,
                    MAX_HANDOFF_BYTES,
                )?,
                write_zip_file(
                    &mut writer,
                    TRANSCRIPT_ENTRY,
                    &transcript_path,
                    options,
                    MAX_TRANSCRIPT_BYTES,
                )?,
            ];
            let envelope = TransferEnvelope {
                format: TRANSFER_FORMAT.to_string(),
                schema: TRANSFER_SCHEMA,
                transfer_id: transfer_id.clone(),
                created_at: Utc::now().to_rfc3339(),
                source_checkpoint_id: manifest.lifecycle.checkpoint_id,
                payloads,
            };
            let envelope_json = serde_json::to_vec_pretty(&envelope)
                .map_err(|error| format!("Failed to serialize transfer metadata: {error}"))?;
            if envelope_json.len() as u64 > MAX_TRANSFER_BYTES {
                return Err("Transfer metadata is too large".to_string());
            }
            writer
                .start_file(TRANSFER_ENTRY, options)
                .map_err(|error| format!("Failed to add transfer metadata: {error}"))?;
            writer
                .write_all(&envelope_json)
                .map_err(|error| format!("Failed to write transfer metadata: {error}"))?;
            writer
                .finish()
                .map_err(|error| format!("Failed to finish transfer file: {error}"))?;
            Ok(())
        })?;
    Ok(ExportSavepointTransferResult {
        path: path_for_display(destination_path),
        transfer_id,
    })
}

fn read_limited_entry(
    archive: &mut ZipArchive<File>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let entry = archive
        .by_name(name)
        .map_err(|error| format!("Transfer entry {name} was not found: {error}"))?;
    if entry.size() > limit {
        return Err(format!("Transfer entry {name} is too large"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read transfer entry {name}: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("Transfer entry {name} is too large"));
    }
    Ok(bytes)
}

fn copy_entry_checked(
    archive: &mut ZipArchive<File>,
    name: &str,
    target: &Path,
    expected: &TransferPayload,
    limit: u64,
) -> Result<(), String> {
    if expected.bytes > limit {
        return Err(format!("Transfer entry {name} is too large"));
    }
    let mut entry = archive
        .by_name(name)
        .map_err(|error| format!("Transfer entry {name} was not found: {error}"))?;
    if entry.size() > limit {
        return Err(format!("Transfer entry {name} is too large"));
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0_u64;
    loop {
        let read = entry
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read transfer entry {name}: {error}"))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        if bytes > limit {
            return Err(format!("Transfer entry {name} is too large"));
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("Failed to write {}: {error}", target.display()))?;
    }
    output
        .sync_all()
        .map_err(|error| format!("Failed to sync {}: {error}", target.display()))?;
    let sha256 = format!("{:x}", hasher.finalize());
    if bytes != expected.bytes || sha256 != expected.sha256 {
        return Err(format!("Transfer entry {name} failed integrity validation"));
    }
    Ok(())
}

fn validate_existing_payload(
    path: &Path,
    name: &str,
    expected: &TransferPayload,
    limit: u64,
) -> Result<(), String> {
    if expected.bytes > limit {
        return Err(format!("Transfer entry {name} is too large"));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Existing imported transfer entry {name} is missing: {error}"))?;
    if !metadata.is_file() || is_link_or_reparse_point(path) || metadata.len() > limit {
        return Err(format!(
            "Existing imported transfer entry {name} is invalid"
        ));
    }
    let mut source = File::open(path)
        .map_err(|error| format!("Failed to open existing transfer entry {name}: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0_u64;
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read existing transfer entry {name}: {error}"))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        if bytes > limit {
            return Err(format!(
                "Existing imported transfer entry {name} is too large"
            ));
        }
        hasher.update(&buffer[..read]);
    }
    let sha256 = format!("{:x}", hasher.finalize());
    if bytes != expected.bytes || sha256 != expected.sha256 {
        return Err(format!(
            "Existing imported transfer entry {name} failed integrity validation"
        ));
    }
    Ok(())
}

fn existing_import(
    target: &Path,
    transfer_id: &str,
    expected_digest: &str,
    handoff_payload: &TransferPayload,
    transcript_payload: &TransferPayload,
) -> Result<Option<ImportSavepointTransferResult>, String> {
    if !target.exists() {
        return Ok(None);
    }
    if is_link_or_reparse_point(target) || !target.is_dir() {
        return Err("Existing imported savepoint is not a regular folder".to_string());
    }
    let (_, manifest) = read_valid_manifest_for_operation(target)?;
    let Some(origin) = manifest.transfer.as_ref() else {
        return Err("Existing imported savepoint has no transfer identity".to_string());
    };
    if origin.id != transfer_id {
        return Err("Transfer id conflicts with an existing local savepoint".to_string());
    }
    if origin.sha256.as_deref() != Some(expected_digest) {
        return Err("Transfer id conflicts with different savepoint contents".to_string());
    }
    let handoff_path = target.join("handoff.md");
    validate_existing_payload(
        &handoff_path,
        HANDOFF_ENTRY,
        handoff_payload,
        MAX_HANDOFF_BYTES,
    )?;
    let transcript_path = find_transcript(target)?;
    validate_existing_payload(
        &transcript_path,
        TRANSCRIPT_ENTRY,
        transcript_payload,
        MAX_TRANSCRIPT_BYTES,
    )?;
    let entry = online_savepoint_entry(target.to_path_buf(), manifest, false)?;
    Ok(Some(ImportSavepointTransferResult {
        bundle_dir: entry.bundle_dir,
        transfer_id: transfer_id.to_string(),
        summary_line: entry.summary_line,
        imported: false,
    }))
}

fn import_savepoint_transfer_at(
    local_dir: &Path,
    source_path: &Path,
) -> Result<ImportSavepointTransferResult, String> {
    if !source_path.is_absolute() || !is_transfer_path(source_path) {
        return Err("Transfer source must be an absolute .mycmux-transfer path".to_string());
    }
    let source_metadata = fs::metadata(source_path)
        .map_err(|error| format!("Failed to inspect {}: {error}", source_path.display()))?;
    if !source_metadata.is_file() || source_metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("Transfer file is missing or too large".to_string());
    }
    let source = File::open(source_path)
        .map_err(|error| format!("Failed to open {}: {error}", source_path.display()))?;
    let mut archive = ZipArchive::new(source)
        .map_err(|error| format!("Failed to read transfer file: {error}"))?;
    if archive.len() != 4 {
        return Err("Transfer file must contain exactly four entries".to_string());
    }
    let allowed = HashSet::from([
        TRANSFER_ENTRY,
        MANIFEST_ENTRY,
        HANDOFF_ENTRY,
        TRANSCRIPT_ENTRY,
    ]);
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect transfer entry: {error}"))?;
        let name = entry.name().to_string();
        let is_symlink = entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000);
        if entry.is_dir() || is_symlink || !allowed.contains(name.as_str()) || !seen.insert(name) {
            return Err("Transfer file contains an unexpected or duplicate entry".to_string());
        }
    }
    let envelope_bytes = read_limited_entry(&mut archive, TRANSFER_ENTRY, MAX_TRANSFER_BYTES)?;
    let envelope: TransferEnvelope = serde_json::from_slice(&envelope_bytes)
        .map_err(|error| format!("Transfer metadata is invalid: {error}"))?;
    if envelope.format != TRANSFER_FORMAT
        || envelope.schema != TRANSFER_SCHEMA
        || Uuid::parse_str(&envelope.transfer_id).is_err()
    {
        return Err("Transfer metadata is unsupported".to_string());
    }
    let digest = transfer_digest(&envelope);
    let payloads = envelope
        .payloads
        .iter()
        .map(|value| (value.path.as_str(), value))
        .collect::<HashMap<_, _>>();
    if payloads.len() != 3
        || !payloads.contains_key(MANIFEST_ENTRY)
        || !payloads.contains_key(HANDOFF_ENTRY)
        || !payloads.contains_key(TRANSCRIPT_ENTRY)
    {
        return Err("Transfer payload list is invalid".to_string());
    }

    fs::create_dir_all(local_dir)
        .map_err(|error| format!("Failed to create {}: {error}", local_dir.display()))?;
    write_storage_marker(local_dir)?;
    let target = local_dir.join(format!("received_{}", envelope.transfer_id));
    if let Some(existing) = existing_import(
        &target,
        &envelope.transfer_id,
        &digest,
        payloads[HANDOFF_ENTRY],
        payloads[TRANSCRIPT_ENTRY],
    )? {
        return Ok(existing);
    }
    let temp = tempfile::Builder::new()
        .prefix(".received.tmp-")
        .tempdir_in(local_dir)
        .map_err(|error| format!("Failed to create import staging folder: {error}"))?;
    fs::create_dir(temp.path().join("transcript"))
        .map_err(|error| format!("Failed to create import transcript folder: {error}"))?;
    copy_entry_checked(
        &mut archive,
        MANIFEST_ENTRY,
        &temp.path().join("manifest.json"),
        payloads[MANIFEST_ENTRY],
        MAX_MANIFEST_BYTES,
    )?;
    copy_entry_checked(
        &mut archive,
        HANDOFF_ENTRY,
        &temp.path().join("handoff.md"),
        payloads[HANDOFF_ENTRY],
        MAX_HANDOFF_BYTES,
    )?;
    copy_entry_checked(
        &mut archive,
        TRANSCRIPT_ENTRY,
        &temp.path().join("transcript").join("session.jsonl"),
        payloads[TRANSCRIPT_ENTRY],
        MAX_TRANSCRIPT_BYTES,
    )?;

    let mut manifest_value: serde_json::Value = read_json(&temp.path().join("manifest.json"))?;
    let mut manifest: SavepointManifest = serde_json::from_value(manifest_value.clone())
        .map_err(|error| format!("Imported savepoint manifest is invalid: {error}"))?;
    if manifest.schema != SAVEPOINT_SCHEMA {
        return Err(format!("Unsupported savepoint schema: {}", manifest.schema));
    }
    manifest.identity()?;
    if manifest.lifecycle.checkpoint_id != envelope.source_checkpoint_id {
        return Err("Transfer checkpoint does not match the savepoint manifest".to_string());
    }
    let now = Utc::now();
    let object = manifest_value
        .as_object_mut()
        .ok_or_else(|| "Imported savepoint manifest is not an object".to_string())?;
    object.remove("trash");
    object.insert(
        "updated_at".to_string(),
        serde_json::Value::String(now.to_rfc3339()),
    );
    object.insert(
        "expires_at".to_string(),
        serde_json::Value::String((now + ChronoDuration::hours(48)).to_rfc3339()),
    );
    object.insert("pinned".to_string(), serde_json::Value::Bool(false));
    object.insert(
        "transfer".to_string(),
        serde_json::json!({
            "id": envelope.transfer_id,
            "received_at": now.to_rfc3339(),
            "sha256": digest,
        }),
    );
    write_json_atomic(&temp.path().join("manifest.json"), &manifest_value)?;
    manifest = read_valid_manifest_for_operation(temp.path())?.1;
    let handoff = fs::metadata(temp.path().join("handoff.md"))
        .map_err(|error| format!("Imported handoff is missing: {error}"))?;
    if handoff.len() == 0 {
        return Err("Imported handoff is empty".to_string());
    }
    find_transcript(temp.path())?;
    fs::rename(temp.path(), &target)
        .map_err(|error| format!("Failed to install imported savepoint: {error}"))?;
    let entry = online_savepoint_entry(target, manifest, false)?;
    Ok(ImportSavepointTransferResult {
        bundle_dir: entry.bundle_dir,
        transfer_id: entry.transfer_id.unwrap_or_default(),
        summary_line: entry.summary_line,
        imported: true,
    })
}

#[tauri::command]
pub async fn export_savepoint_transfer(
    bundle_dir: String,
    destination_path: String,
) -> Result<ExportSavepointTransferResult, String> {
    run_blocking("export_savepoint_transfer", move || {
        let _publish_guard = super::super::online_publish::PUBLISH_LOCK
            .lock()
            .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
        let home =
            dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
        let config_path = home.join(".mycmux").join("savepoint.json");
        let local_dir = local_savepoint_dir_from_config(&config_path, &home)?;
        export_savepoint_transfer_at(
            &local_dir,
            Path::new(&bundle_dir),
            Path::new(&destination_path),
        )
    })
    .await
}

#[tauri::command]
pub async fn import_savepoint_transfer(
    source_path: String,
) -> Result<ImportSavepointTransferResult, String> {
    run_blocking("import_savepoint_transfer", move || {
        let _publish_guard = super::super::online_publish::PUBLISH_LOCK
            .lock()
            .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
        let home =
            dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
        let config_path = home.join(".mycmux").join("savepoint.json");
        let local_dir = local_savepoint_dir_from_config(&config_path, &home)?;
        import_savepoint_transfer_at(&local_dir, Path::new(&source_path))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const FINAL_CHECKPOINT_ID: &str = "11111111-2222-4333-8444-555555555555";

    fn copy_fixture_bundle(target: &Path) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("commands")
            .join("fixtures")
            .join("online_savepoint")
            .join("miyazaki_85d1dd8d");
        fs::create_dir_all(target.join("transcript")).unwrap();
        fs::copy(source.join("manifest.json"), target.join("manifest.json")).unwrap();
        fs::copy(source.join("handoff.md"), target.join("handoff.md")).unwrap();
        let transcript = fs::read_dir(source.join("transcript"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::copy(transcript, target.join("transcript").join("session.jsonl")).unwrap();
    }

    fn mark_bundle_final(target: &Path) {
        let manifest_path = target.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        manifest["pinned"] = serde_json::Value::Bool(true);
        manifest["lifecycle"] = serde_json::json!({
            "status": "closed",
            "checkpoint_id": FINAL_CHECKPOINT_ID,
            "parent_checkpoint_id": null,
            "final_checkpoint": true,
            "closed_at": "2026-07-14T12:00:00+09:00",
            "closed_reason": "manual"
        });
        write_json_atomic(&manifest_path, &manifest).unwrap();
    }

    #[test]
    fn transfer_round_trip_is_local_and_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let local_dir = temp.path().join("savepoints");
        let source_bundle = local_dir.join("source");
        fs::create_dir_all(&local_dir).unwrap();
        copy_fixture_bundle(&source_bundle);
        let transfer_path = temp.path().join("handoff.mycmux-transfer");

        let exported =
            export_savepoint_transfer_at(&local_dir, &source_bundle, &transfer_path).unwrap();
        assert!(transfer_path.is_file());

        let first = import_savepoint_transfer_at(&local_dir, &transfer_path).unwrap();
        let second = import_savepoint_transfer_at(&local_dir, &transfer_path).unwrap();
        assert!(first.imported);
        assert!(!second.imported);
        assert_eq!(first.transfer_id, exported.transfer_id);
        assert_eq!(first.bundle_dir, second.bundle_dir);
        assert!(Path::new(&first.bundle_dir).join("handoff.md").is_file());
        assert!(Path::new(&first.bundle_dir)
            .join("transcript")
            .join("session.jsonl")
            .is_file());
    }

    #[test]
    fn import_rejects_extra_archive_entries_without_creating_a_bundle() {
        let temp = tempfile::tempdir().unwrap();
        let transfer_path = temp.path().join("bad.mycmux-transfer");
        let file = File::create(&transfer_path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for name in [
            TRANSFER_ENTRY,
            MANIFEST_ENTRY,
            HANDOFF_ENTRY,
            TRANSCRIPT_ENTRY,
            "../escape",
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(b"{}").unwrap();
        }
        writer.finish().unwrap();
        let local_dir = temp.path().join("savepoints");

        let error = import_savepoint_transfer_at(&local_dir, &transfer_path).unwrap_err();
        assert!(error.contains("exactly four"));
        assert!(!local_dir.exists());
    }

    #[test]
    fn export_rejects_a_bundle_outside_the_local_store() {
        let temp = tempfile::tempdir().unwrap();
        let local_dir = temp.path().join("savepoints");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&local_dir).unwrap();
        copy_fixture_bundle(&outside);
        let transfer_path = temp.path().join("outside.mycmux-transfer");

        let error = export_savepoint_transfer_at(&local_dir, &outside, &transfer_path).unwrap_err();
        assert!(error.contains("must be inside"));
        assert!(!transfer_path.exists());
    }

    #[test]
    fn export_rejects_an_oversized_payload_without_leaving_a_file() {
        let temp = tempfile::tempdir().unwrap();
        let local_dir = temp.path().join("savepoints");
        let source_bundle = local_dir.join("source");
        fs::create_dir_all(&local_dir).unwrap();
        copy_fixture_bundle(&source_bundle);
        fs::write(
            source_bundle.join("handoff.md"),
            vec![b'x'; (MAX_HANDOFF_BYTES + 1) as usize],
        )
        .unwrap();
        let transfer_path = temp.path().join("too-large.mycmux-transfer");

        let error =
            export_savepoint_transfer_at(&local_dir, &source_bundle, &transfer_path).unwrap_err();

        assert!(error.contains("too large"));
        assert!(!transfer_path.exists());
    }

    #[test]
    fn reimport_rejects_a_conflicting_local_transfer_identity() {
        let temp = tempfile::tempdir().unwrap();
        let local_dir = temp.path().join("savepoints");
        let source_bundle = local_dir.join("source");
        fs::create_dir_all(&local_dir).unwrap();
        copy_fixture_bundle(&source_bundle);
        let transfer_path = temp.path().join("handoff.mycmux-transfer");
        export_savepoint_transfer_at(&local_dir, &source_bundle, &transfer_path).unwrap();
        let imported = import_savepoint_transfer_at(&local_dir, &transfer_path).unwrap();
        let manifest_path = Path::new(&imported.bundle_dir).join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        manifest["transfer"]["sha256"] = serde_json::Value::String("different".to_string());
        write_json_atomic(&manifest_path, &manifest).unwrap();

        let error = import_savepoint_transfer_at(&local_dir, &transfer_path).unwrap_err();

        assert!(error.contains("different savepoint contents"));
    }

    #[test]
    fn reimport_rejects_a_corrupted_existing_payload() {
        let temp = tempfile::tempdir().unwrap();
        let local_dir = temp.path().join("savepoints");
        let source_bundle = local_dir.join("source");
        fs::create_dir_all(&local_dir).unwrap();
        copy_fixture_bundle(&source_bundle);
        let transfer_path = temp.path().join("handoff.mycmux-transfer");
        export_savepoint_transfer_at(&local_dir, &source_bundle, &transfer_path).unwrap();
        let imported = import_savepoint_transfer_at(&local_dir, &transfer_path).unwrap();
        fs::write(
            Path::new(&imported.bundle_dir)
                .join("transcript")
                .join("session.jsonl"),
            b"corrupted transcript",
        )
        .unwrap();

        let error = import_savepoint_transfer_at(&local_dir, &transfer_path).unwrap_err();

        assert!(error.contains("failed integrity validation"));
    }

    #[test]
    fn received_final_can_be_trashed_and_purged_from_its_transfer_stable_name() {
        let temp = tempfile::tempdir().unwrap();
        let local_dir = temp.path().join("savepoints");
        let source_bundle = local_dir.join(FINAL_RECORDS_DIR).join(FINAL_CHECKPOINT_ID);
        fs::create_dir_all(local_dir.join(FINAL_RECORDS_DIR)).unwrap();
        copy_fixture_bundle(&source_bundle);
        mark_bundle_final(&source_bundle);
        let transfer_path = temp.path().join("final.mycmux-transfer");
        export_savepoint_transfer_at(&local_dir, &source_bundle, &transfer_path).unwrap();
        let imported = import_savepoint_transfer_at(&local_dir, &transfer_path).unwrap();
        let imported_path = PathBuf::from(&imported.bundle_dir);

        let trashed = trash_online_savepoint_at(
            &local_dir,
            &imported_path,
            "2026-07-14T13:00:00+09:00",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let trash_id = trashed.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!imported_path.exists());

        purge_online_savepoint_at(&local_dir, &trashed, &trash_id).unwrap();
        assert!(!trashed.exists());
    }

    #[test]
    fn cleanup_moves_an_expired_received_final_to_the_trash() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let local_dir = home.join(".mycmux").join("savepoints");
        let source_bundle = local_dir.join(FINAL_RECORDS_DIR).join(FINAL_CHECKPOINT_ID);
        fs::create_dir_all(local_dir.join(FINAL_RECORDS_DIR)).unwrap();
        copy_fixture_bundle(&source_bundle);
        mark_bundle_final(&source_bundle);
        let transfer_path = temp.path().join("final.mycmux-transfer");
        export_savepoint_transfer_at(&local_dir, &source_bundle, &transfer_path).unwrap();
        let imported = import_savepoint_transfer_at(&local_dir, &transfer_path).unwrap();
        let imported_path = PathBuf::from(&imported.bundle_dir);
        let config_path = home.join(".mycmux").join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": local_dir }).to_string(),
        )
        .unwrap();
        let cleanup_time = Utc::now() + ChronoDuration::hours(49);
        let cleanup_system_time = SystemTime::now() + Duration::from_secs(49 * 60 * 60);

        let result = cleanup_online_savepoints_from_config(
            &config_path,
            &home,
            cleanup_time,
            cleanup_system_time,
        )
        .unwrap();

        assert_eq!(result.expired_count, 1);
        assert!(!imported_path.exists());
        assert_eq!(
            fs::read_dir(local_dir.join(TRASH_DIR))
                .unwrap()
                .flatten()
                .count(),
            1
        );
    }
}
