use super::{
    model::{Closed, Closure},
    safe,
};
use std::fs::OpenOptions;
use std::path::Path;
pub fn read(directory: &Path) -> Result<Closed, String> {
    let path = directory.join("closed.json");
    if !path.exists() {
        return Ok(Closed::default());
    }
    let value: Closed =
        serde_json::from_str(&safe::text(&path, safe::DOCUMENT_LIMIT).ok_or("closedUnavailable")?)
            .map_err(|_| "closedUnsupported")?;
    if value.schema_version != 1
        || value.closed.iter().any(|c| {
            c.id.is_empty()
                || c.reason.trim().is_empty()
                || c.reason.chars().count() > 1000
                || !["pc", "iphone"].contains(&c.closed_from.as_str())
                || !Path::new(&c.cwd).is_absolute()
        })
    {
        return Err("closedUnsupported".into());
    }
    Ok(value)
}
pub fn merge(
    directory: &Path,
    observed_revision: u64,
    entry: Closure,
) -> Result<(Closed, bool), String> {
    if entry.id.is_empty()
        || entry.reason.trim().is_empty()
        || entry.reason.chars().count() > 1000
        || !["pc", "iphone"].contains(&entry.closed_from.as_str())
        || !Path::new(&entry.cwd).is_absolute()
        || chrono::DateTime::parse_from_rfc3339(&entry.date).is_err()
    {
        return Err("closureUnsupported".into());
    }
    // Both writers lock this persistent inode before the final read/merge/replace.
    // Never delete it; dropping the handle releases the OS lock on every exit.
    let target = safe::state_target(directory, "closed.lock")?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(target)
        .map_err(|e| {
            format!(
                "stateLockOpenFailed:{:?}:{}",
                e.kind(),
                e.raw_os_error().unwrap_or(0)
            )
        })?;
    lock.lock().map_err(|e| {
        format!(
            "stateLockFailed:{:?}:{}",
            e.kind(),
            e.raw_os_error().unwrap_or(0)
        )
    })?;
    let mut latest = read(directory)?;
    let reloaded = latest.revision != observed_revision;
    latest.closed.retain(|c| {
        !(c.id == entry.id
            && safe::normalized(Path::new(&c.cwd)) == safe::normalized(Path::new(&entry.cwd)))
    });
    latest.closed.push(entry);
    latest.schema_version = 1;
    latest.revision = latest
        .revision
        .checked_add(1)
        .ok_or("closedRevisionOverflow")?;
    safe::write_json(directory, "closed.json", &latest)?;
    Ok((latest, reloaded))
}
