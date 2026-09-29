use std::path::Path;

use crate::util::atomic_write::AtomicWrite;

/// Replace `path` with `bytes`, creating the parent directory chain first.
///
/// Credential snapshots and the account registry both live under directories
/// that may not exist yet on a fresh profile, hence `create_parents`.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    AtomicWrite::new("temporary file", "Failed to replace file atomically")
        .create_parents()
        .write_bytes(path, bytes)
}
