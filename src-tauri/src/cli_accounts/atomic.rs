use std::fs;
use std::io::Write;
use std::path::Path;

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "Atomic write path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
    let name = path.file_name().ok_or_else(|| "Atomic write path has no filename".to_string())?;
    let mut tmp_name = name.to_os_string();
    tmp_name.push(".tmp");
    let tmp = parent.join(tmp_name);
    let result = (|| {
        let mut file = fs::File::create(&tmp).map_err(|e| format!("Failed to create temporary file: {e}"))?;
        file.write_all(bytes).map_err(|e| format!("Failed to write temporary file: {e}"))?;
        file.sync_all().map_err(|e| format!("Failed to sync temporary file: {e}"))?;
        fs::rename(&tmp, path).map_err(|e| format!("Failed to replace file atomically: {e}"))
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result
}
