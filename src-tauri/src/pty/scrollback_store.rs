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

pub fn load(dir: &Path, session_id: &str) -> Option<PersistedScrollback> {
    let path = session_path(dir, session_id).ok()?;
    let bytes = fs::read(path).ok()?;
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

pub fn save(
    dir: &Path,
    session_id: &str,
    start_offset: u64,
    end_offset: u64,
    data: &[u8],
) -> io::Result<()> {
    let file_name = session_file_name(session_id)?;
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
    let path = session_path(dir, session_id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
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

pub fn gc(dir: &Path, keep: &HashSet<String>) -> io::Result<()> {
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
        if !keep.contains(session_id) {
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
}
