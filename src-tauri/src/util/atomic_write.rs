//! Crash-safe file replacement.
//!
//! Every writer here follows the same shape: create a temporary file in the
//! destination's own directory, fill it, `flush` + `sync_all` it, then rename
//! it over the destination. The fsync is what makes the rename meaningful — a
//! rename that lands before the data reaches the disk leaves a truncated file
//! after a power loss, which is exactly the failure mode `data.json`,
//! savepoint manifests, and CLI credential snapshots must not have.
//!
//! The temporary file is created by `tempfile::NamedTempFile`, so it is
//! removed automatically when a write fails partway through, and a name
//! collision with a concurrent writer is impossible.
//!
//! Error wording is per call site: `AtomicWrite` carries the noun used in the
//! temp-file messages and the prefix used for the replace failure, so callers
//! keep the diagnostics they had before sharing this code.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

/// Private to file I/O: never return these paths to WebView/Chromium callers.
/// Resolve relative components before adding a verbatim prefix, without
/// requiring the destination (or its parents) to exist. Preserve OS strings.
fn filesystem_write_path(path: &Path) -> std::io::Result<std::borrow::Cow<'_, Path>> {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use std::path::{Component, PathBuf, Prefix};

        let absolute = std::path::absolute(path)?;
        let extended = match absolute.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(_) => {
                    let mut value = OsString::from(r"\\?\");
                    value.push(absolute.as_os_str());
                    value
                }
                Prefix::UNC(_, _) => {
                    let wide: Vec<u16> = absolute.as_os_str().encode_wide().collect();
                    let mut value = OsString::from(r"\\?\UNC\");
                    value.push(OsString::from_wide(&wide[2..]));
                    value
                }
                _ => return Ok(std::borrow::Cow::Owned(absolute)),
            },
            _ => return Ok(std::borrow::Cow::Owned(absolute)),
        };
        Ok(std::borrow::Cow::Owned(PathBuf::from(extended)))
    }
    #[cfg(not(windows))]
    {
        Ok(std::borrow::Cow::Borrowed(path))
    }
}

/// A configured atomic writer for one call site.
pub struct AtomicWrite {
    temp_label: String,
    replace_prefix: String,
    parent_missing: String,
    create_parents: bool,
}

impl AtomicWrite {
    /// `temp_label` is the noun in `Failed to create/write/flush/sync <label>`.
    /// `replace_prefix` is everything before the error in the replace failure
    /// message (`<prefix>: <error>`).
    pub fn new(temp_label: impl Into<String>, replace_prefix: impl Into<String>) -> Self {
        Self {
            temp_label: temp_label.into(),
            replace_prefix: replace_prefix.into(),
            parent_missing: "Atomic write path has no parent".to_string(),
            create_parents: false,
        }
    }

    /// Override the error returned when the destination has no parent directory.
    pub fn parent_missing(mut self, message: impl Into<String>) -> Self {
        self.parent_missing = message.into();
        self
    }

    /// Create the destination's parent directory chain before writing.
    pub fn create_parents(mut self) -> Self {
        self.create_parents = true;
        self
    }

    /// Replace `path` with `bytes`.
    pub fn write_bytes(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        self.write_with(path, |file| {
            file.write_all(bytes)
                .map_err(|error| format!("Failed to write {}: {error}", self.temp_label))
        })
    }

    /// Replace `path` with whatever `fill` writes into the temporary file.
    ///
    /// Use this when the payload is streamed (a zip archive, a copy from
    /// another file) rather than held in memory. `fill` owns its own error
    /// messages; anything it returns is passed through unchanged.
    pub fn write_with<F>(&self, path: &Path, fill: F) -> Result<(), String>
    where
        F: FnOnce(&mut File) -> Result<(), String>,
    {
        path.parent().ok_or_else(|| self.parent_missing.clone())?;
        let path = filesystem_write_path(path)
            .map_err(|error| format!("Failed to resolve write path: {error}"))?;
        let parent = path.parent().ok_or_else(|| self.parent_missing.clone())?;
        if self.create_parents {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create parent directory: {error}"))?;
        }
        let mut temp = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("Failed to create {}: {error}", self.temp_label))?;
        fill(temp.as_file_mut())?;
        temp.flush()
            .map_err(|error| format!("Failed to flush {}: {error}", self.temp_label))?;
        temp.as_file()
            .sync_all()
            .map_err(|error| format!("Failed to sync {}: {error}", self.temp_label))?;
        temp.persist(path.as_ref())
            .map(|_| ())
            .map_err(|error| format!("{}: {}", self.replace_prefix, error.error))
    }
}

/// Write `bytes` to `path` (truncating an existing file) and fsync before
/// returning.
///
/// Not atomic on its own — this is the building block for callers that manage
/// the rename themselves because they need extra steps in between (`db::storage`
/// takes a pre-replace backup of the live file first).
pub fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let path = filesystem_write_path(path)
        .map_err(|error| format!("Failed to resolve write path: {error}"))?;
    let mut file = File::create(path.as_ref())
        .map_err(|error| format!("Failed to create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("Failed to flush {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_bytes_replaces_existing_file_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        fs::write(&path, b"old").unwrap();

        AtomicWrite::new("temporary file", "Failed to replace file atomically")
            .write_bytes(&path, b"new")
            .unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new");
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["data.json".to_string()]);
    }

    #[test]
    fn create_parents_builds_missing_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a").join("b").join("state.json");

        AtomicWrite::new("temporary file", "Failed to replace file atomically")
            .create_parents()
            .write_bytes(&path, b"{}")
            .unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"{}");
    }

    #[test]
    fn missing_parent_directory_without_create_parents_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("state.json");

        let error = AtomicWrite::new("temporary manifest", "Failed to replace manifest")
            .write_bytes(&path, b"{}")
            .unwrap_err();

        assert!(
            error.starts_with("Failed to create temporary manifest: "),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn fill_error_propagates_and_destination_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        fs::write(&path, b"old").unwrap();

        let error = AtomicWrite::new("temporary file", "Failed to replace file atomically")
            .write_with(&path, |_file| Err("payload build failed".to_string()))
            .unwrap_err();

        assert_eq!(error, "payload build failed");
        assert_eq!(fs::read(&path).unwrap(), b"old");
    }

    #[test]
    fn long_destination_supports_create_replace_sync_and_failed_fill() {
        let dir = tempfile::tempdir().unwrap();
        let mut parent = dir.path().to_path_buf();
        for _ in 0..7 {
            parent.push("long-write-directory-0123456789abcdef");
        }
        let path = parent.join("data.json");
        assert!(path.as_os_str().len() > 260);
        let writer = AtomicWrite::new("temporary file", "Failed to replace file atomically")
            .create_parents();
        writer.write_bytes(&path, b"first").unwrap();
        writer.write_bytes(&path, b"replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        let error = writer.write_with(&path, |_| Err("failed fill".into())).unwrap_err();
        assert_eq!(error, "failed fill");
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        write_synced(&path, b"short").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"short");
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn filesystem_paths_normalize_disk_unc_relative_and_existing_prefixes() {
        assert_eq!(
            filesystem_write_path(Path::new(r"C:\folder\..\target\file.json")).unwrap().as_ref(),
            Path::new(r"\\?\C:\target\file.json"),
        );
        assert_eq!(
            filesystem_write_path(Path::new(r"\\server\share\folder\file.json")).unwrap().as_ref(),
            Path::new(r"\\?\UNC\server\share\folder\file.json"),
        );
        let already = Path::new(r"\\?\C:\target\file.json");
        assert_eq!(filesystem_write_path(already).unwrap().as_ref(), already);
        let relative = filesystem_write_path(Path::new("folder/../file.json")).unwrap();
        assert_eq!(
            relative,
            filesystem_write_path(&std::env::current_dir().unwrap().join("file.json")).unwrap(),
        );
    }

    #[test]
    fn write_synced_creates_and_truncates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json.tmp-1");

        write_synced(&path, b"longer payload").unwrap();
        write_synced(&path, b"short").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"short");
    }
}
