use crc32fast::hash;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};

const MAGIC: &[u8; 4] = b"MSBK";
const VERSION: u16 = 1;
const HEADER_LEN: usize = 32;

pub struct PersistedScrollback {
    pub start_offset: u64,
    pub end_offset: u64,
    pub data: Vec<u8>,
}

fn session_file_name(session_id: &str) -> io::Result<String> {
    let mut components = Path::new(session_id).components();
    let is_single_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if session_id.is_empty() || !is_single_normal_component {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "scrollback session id must be a single file name",
        ));
    }
    Ok(format!("{session_id}.bin"))
}

fn session_path(dir: &Path, session_id: &str) -> io::Result<std::path::PathBuf> {
    Ok(dir.join(session_file_name(session_id)?))
}

fn is_canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn stable_tab_id_from_session_id(session_id: &str) -> Option<&str> {
    let tab_id_start = session_id.len().checked_sub(36)?;
    let tab_id = session_id.get(tab_id_start..)?;
    (session_id.starts_with("pty-")
        && tab_id_start > 0
        && session_id.as_bytes().get(tab_id_start - 1) == Some(&b'-')
        && is_canonical_uuid(tab_id))
    .then_some(tab_id)
}

fn scrollback_storage_id(session_id: &str) -> &str {
    stable_tab_id_from_session_id(session_id).unwrap_or(session_id)
}

fn unique_legacy_scrollback_path(dir: &Path, tab_id: &str) -> Option<std::path::PathBuf> {
    let suffix = format!("-{tab_id}.bin");
    let candidates = fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_type().ok()?.is_file().then_some(entry))
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("pty-") && name.ends_with(&suffix)
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    (candidates.len() == 1).then(|| candidates.into_iter().next()).flatten()
}

fn parse_persisted_scrollback(bytes: &[u8]) -> Option<PersistedScrollback> {
    if bytes.len() < HEADER_LEN || &bytes[..4] != MAGIC {
        return None;
    }

    let version = u16::from_le_bytes(bytes[4..6].try_into().ok()?);
    if version != VERSION {
        return None;
    }
    let flags = u16::from_le_bytes(bytes[6..8].try_into().ok()?);
    if flags != 0 {
        return None;
    }
    let start_offset = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let end_offset = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
    let data_len = u32::from_le_bytes(bytes[24..28].try_into().ok()?) as usize;
    let expected_crc = u32::from_le_bytes(bytes[28..32].try_into().ok()?);
    let data = &bytes[HEADER_LEN..];
    if data.len() != data_len
        || end_offset.checked_sub(start_offset)? != data_len as u64
        || hash(data) != expected_crc
    {
        return None;
    }

    Some(PersistedScrollback {
        start_offset,
        end_offset,
        data: data.to_vec(),
    })
}

pub fn load(dir: &Path, session_id: &str) -> Option<PersistedScrollback> {
    let storage_id = scrollback_storage_id(session_id);
    let path = session_path(dir, storage_id).ok()?;
    if path.exists() {
        return parse_persisted_scrollback(&fs::read(path).ok()?);
    }

    let tab_id = stable_tab_id_from_session_id(session_id)?;
    let legacy_path = unique_legacy_scrollback_path(dir, tab_id)?;
    let persisted = parse_persisted_scrollback(&fs::read(&legacy_path).ok()?)?;
    fs::rename(legacy_path, path).ok()?;
    Some(persisted)
}

pub fn save(
    dir: &Path,
    session_id: &str,
    start_offset: u64,
    end_offset: u64,
    data: &[u8],
) -> io::Result<()> {
    let file_name = session_file_name(scrollback_storage_id(session_id))?;
    let data_len = u32::try_from(data.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "scrollback data exceeds the on-disk format limit",
        )
    })?;
    fs::create_dir_all(dir)?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = dir.join(&file_name);
    let tmp_path = dir.join(format!(
        "{file_name}.tmp-{}-{timestamp}",
        std::process::id()
    ));

    let write_result = (|| -> io::Result<()> {
        let mut file = File::create(&tmp_path)?;
        file.write_all(MAGIC)?;
        file.write_all(&VERSION.to_le_bytes())?;
        file.write_all(&0u16.to_le_bytes())?;
        file.write_all(&start_offset.to_le_bytes())?;
        file.write_all(&end_offset.to_le_bytes())?;
        file.write_all(&data_len.to_le_bytes())?;
        file.write_all(&hash(data).to_le_bytes())?;
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&tmp_path, &path)
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

pub fn remove(dir: &Path, session_id: &str) -> io::Result<()> {
    let path = session_path(dir, scrollback_storage_id(session_id))?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }?;
    if path.file_stem().and_then(|stem| stem.to_str()) != Some(session_id) {
        let legacy_path = session_path(dir, session_id)?;
        match fs::remove_file(legacy_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    } else {
        Ok(())
    }
}

pub fn remove_many<I, S>(dir: &Path, session_ids: I) -> io::Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for session_id in session_ids {
        remove(dir, session_id.as_ref())?;
    }
    Ok(())
}

pub fn remove_prefix(dir: &Path, prefix: &str) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(".bin") {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn gc(dir: &Path, keep: &HashSet<String>) -> io::Result<()> {
    gc_guarded(dir, keep, || Ok(()))
}

pub(crate) fn gc_guarded<F>(
    dir: &Path,
    keep: &HashSet<String>,
    mut before_remove: F,
) -> io::Result<()>
where
    F: FnMut() -> io::Result<()>,
{
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(session_id) = name.strip_suffix(".bin") else {
            continue;
        };
        let is_legacy_live_tab = keep.iter().any(|tab_id| {
            session_id.starts_with("pty-")
                && session_id.ends_with(&format!("-{tab_id}"))
        });
        if !keep.contains(session_id) && !is_legacy_live_tab {
            before_remove()?;
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

pub fn sanitize_ring_head(start_offset: u64, data: &[u8]) -> (u64, &[u8]) {
    if start_offset == 0 {
        return (start_offset, data);
    }
    let discarded = data
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|position| position + 1)
        .unwrap_or(data.len());
    (
        start_offset.saturating_add(discarded as u64),
        &data[discarded..],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_legacy_scrollback_file(
        dir: &Path,
        legacy_session_id: &str,
        start_offset: u64,
        end_offset: u64,
        data: &[u8],
    ) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&VERSION.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&start_offset.to_le_bytes());
        bytes.extend_from_slice(&end_offset.to_le_bytes());
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&hash(data).to_le_bytes());
        bytes.extend_from_slice(data);
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(session_file_name(legacy_session_id).unwrap()), bytes).unwrap();
    }

    #[test]
    fn round_trip_preserves_offsets_and_data() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(), "pty-one", 12, 15, b"abc").unwrap();

        let loaded = load(temp.path(), "pty-one").unwrap();
        assert_eq!(loaded.start_offset, 12);
        assert_eq!(loaded.end_offset, 15);
        assert_eq!(loaded.data, b"abc");
    }

    #[test]
    fn corrupt_crc_is_treated_as_missing() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(), "pty-one", 0, 3, b"abc").unwrap();
        let path = temp.path().join("pty-one.bin");
        let mut bytes = fs::read(&path).unwrap();
        bytes[31] ^= 0xff;
        fs::write(path, bytes).unwrap();

        assert!(load(temp.path(), "pty-one").is_none());
    }

    #[test]
    fn unsupported_version_is_treated_as_missing() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(), "pty-one", 0, 3, b"abc").unwrap();
        let path = temp.path().join("pty-one.bin");
        let mut bytes = fs::read(&path).unwrap();
        bytes[4..6].copy_from_slice(&2u16.to_le_bytes());
        fs::write(path, bytes).unwrap();

        assert!(load(temp.path(), "pty-one").is_none());
    }

    #[test]
    fn invalid_magic_is_treated_as_missing() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(), "pty-one", 0, 3, b"abc").unwrap();
        let path = temp.path().join("pty-one.bin");
        let mut bytes = fs::read(&path).unwrap();
        bytes[..4].copy_from_slice(b"NOPE");
        fs::write(path, bytes).unwrap();

        assert!(load(temp.path(), "pty-one").is_none());
    }

    #[test]
    fn nonzero_flags_are_treated_as_missing() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(), "pty-one", 0, 3, b"abc").unwrap();
        let path = temp.path().join("pty-one.bin");
        let mut bytes = fs::read(&path).unwrap();
        bytes[6..8].copy_from_slice(&1u16.to_le_bytes());
        fs::write(path, bytes).unwrap();

        assert!(load(temp.path(), "pty-one").is_none());
    }

    #[test]
    fn invalid_data_length_is_treated_as_missing() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(), "pty-one", 0, 3, b"abc").unwrap();
        let path = temp.path().join("pty-one.bin");
        let mut bytes = fs::read(&path).unwrap();
        bytes[24..28].copy_from_slice(&4u32.to_le_bytes());
        fs::write(path, bytes).unwrap();

        assert!(load(temp.path(), "pty-one").is_none());
    }

    #[test]
    fn sanitize_ring_head_leaves_offset_zero_untouched() {
        assert_eq!(
            sanitize_ring_head(0, b"\x1b[31mhello"),
            (0, b"\x1b[31mhello".as_slice())
        );
    }

    #[test]
    fn sanitize_ring_head_discards_through_first_line_feed() {
        assert_eq!(
            sanitize_ring_head(10, b"partial\nwhole"),
            (18, b"whole".as_slice())
        );
    }

    #[test]
    fn sanitize_ring_head_discards_all_without_line_feed_or_data() {
        assert_eq!(sanitize_ring_head(10, b"partial"), (17, b"".as_slice()));
        assert_eq!(sanitize_ring_head(10, b""), (10, b"".as_slice()));
    }

    #[test]
    fn gc_keeps_referenced_files_and_removes_orphans() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(), "pty-keep", 0, 1, b"a").unwrap();
        save(temp.path(), "pty-drop", 0, 1, b"b").unwrap();
        fs::write(temp.path().join("unrelated.txt"), "keep").unwrap();
        let keep = HashSet::from(["pty-keep".to_string()]);

        gc(temp.path(), &keep).unwrap();

        assert!(temp.path().join("pty-keep.bin").exists());
        assert!(!temp.path().join("pty-drop.bin").exists());
        assert!(temp.path().join("unrelated.txt").exists());
    }

    #[test]
    fn guarded_gc_checks_immediately_before_every_remove() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(), "pty-drop-one", 0, 1, b"a").unwrap();
        save(temp.path(), "pty-drop-two", 0, 1, b"b").unwrap();
        let mut checks = 0;

        let error = gc_guarded(temp.path(), &HashSet::new(), || {
            checks += 1;
            if checks == 2 {
                return Err(io::Error::other("retention input changed"));
            }
            Ok(())
        })
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(checks, 2);
        let remaining = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("bin"))
            .count();
        assert_eq!(remaining, 1);
    }

    #[test]
    fn remove_prefix_only_removes_matching_scrollback_files() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(), "pty-workspace-a", 0, 1, b"a").unwrap();
        save(temp.path(), "pty-other-a", 0, 1, b"b").unwrap();
        fs::write(temp.path().join("pty-workspace-a.bin.tmp"), "tmp").unwrap();

        remove_prefix(temp.path(), "pty-workspace-").unwrap();

        assert!(!temp.path().join("pty-workspace-a.bin").exists());
        assert!(temp.path().join("pty-other-a.bin").exists());
        assert!(temp.path().join("pty-workspace-a.bin.tmp").exists());
    }

    #[test]
    fn migrates_five_moved_tab_legacy_files_to_stable_tab_keys() {
        let temp = tempfile::tempdir().unwrap();
        let old_workspace = "5231da42-1111-4111-8111-111111111111";
        let current_workspace = "c30892d0-2222-4222-8222-222222222222";
        let pane_id = "bb391b49-3333-4333-8333-333333333333";
        let tab_ids = [
            "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
            "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
            "33333333-cccc-4ccc-8ccc-ccccccccccc3",
            "44444444-dddd-4ddd-8ddd-ddddddddddd4",
            "55555555-eeee-4eee-8eee-eeeeeeeeeee5",
        ];

        for (index, tab_id) in tab_ids.iter().enumerate() {
            let legacy_id = format!("pty-{old_workspace}-{pane_id}-{tab_id}");
            write_legacy_scrollback_file(
                temp.path(),
                &legacy_id,
                index as u64,
                index as u64 + 1,
                &[index as u8],
            );
            let current_id = format!("pty-{current_workspace}-{pane_id}-{tab_id}");

            let loaded = load(temp.path(), &current_id).unwrap();
            assert_eq!(loaded.data, vec![index as u8]);
            assert!(temp.path().join(format!("{tab_id}.bin")).exists());
            assert!(!temp.path().join(format!("{legacy_id}.bin")).exists());
        }
    }

    #[test]
    fn save_uses_the_stable_tab_key_for_a_composite_session_id() {
        let temp = tempfile::tempdir().unwrap();
        let tab_id = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
        let session_id = format!(
            "pty-5231da42-1111-4111-8111-111111111111-bb391b49-3333-4333-8333-333333333333-{tab_id}"
        );

        save(temp.path(), &session_id, 0, 1, b"a").unwrap();

        assert!(temp.path().join(format!("{tab_id}.bin")).exists());
        assert!(!temp.path().join(format!("{session_id}.bin")).exists());
    }

    #[test]
    fn ambiguous_legacy_scrollback_files_do_not_migrate() {
        let temp = tempfile::tempdir().unwrap();
        let tab_id = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
        let old_a = format!(
            "pty-5231da42-1111-4111-8111-111111111111-bb391b49-3333-4333-8333-333333333333-{tab_id}"
        );
        let old_b = format!(
            "pty-c30892d0-2222-4222-8222-222222222222-bb391b49-3333-4333-8333-333333333333-{tab_id}"
        );
        write_legacy_scrollback_file(temp.path(), &old_a, 0, 1, b"a");
        write_legacy_scrollback_file(temp.path(), &old_b, 0, 1, b"b");

        assert!(load(temp.path(), &old_b).is_none());
        assert!(!temp.path().join(format!("{tab_id}.bin")).exists());
    }
}
