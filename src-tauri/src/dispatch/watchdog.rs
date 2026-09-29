use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::ledger;

#[derive(Debug, Deserialize, Serialize)]
struct LockRecord {
    owner: String,
    pid: u32,
    ts: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn write_record(path: &Path, record: &LockRecord) -> io::Result<()> {
    let json = serde_json::to_string(record).map_err(io::Error::other)?;
    fs::write(path, json.as_bytes())
}

fn claim_at_path(path: &Path, ttl_ms: u64, now: u64, pid: u32) -> io::Result<bool> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let record = LockRecord { owner: "mycmux".to_owned(), pid, ts: now };
    match fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<LockRecord>(&bytes).ok()) {
        Some(existing) if existing.pid != pid && now.saturating_sub(existing.ts) <= ttl_ms => Ok(false),
        _ => {
            if !path.exists() {
                match OpenOptions::new().write(true).create_new(true).open(path) {
                    Ok(_) => return write_record(path, &record).map(|_| true),
                    Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(error),
                    Err(_) => {}
                }
            }
            write_record(path, &record).map(|_| true)
        }
    }
}

pub fn claim(ttl_ms: u64) -> io::Result<bool> {
    let Some(ledger_path) = ledger::ledger_path() else { return Ok(false); };
    let Some(parent) = ledger_path.parent() else { return Ok(false); };
    claim_at_path(&parent.join(".watchdog.lock"), ttl_ms, now_ms(), std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn claims_missing_lock_and_renews_own_lock() {
        let temp = tempdir().unwrap();
        let path = temp.path().join(".watchdog.lock");
        assert!(claim_at_path(&path, 100, 1_000, 7).unwrap());
        assert!(claim_at_path(&path, 100, 1_001, 7).unwrap());
        let record: LockRecord = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(record.pid, 7);
        assert_eq!(record.ts, 1_001);
    }

    #[test]
    fn refuses_other_live_owner_and_steals_expired_owner() {
        let temp = tempdir().unwrap();
        let path = temp.path().join(".watchdog.lock");
        assert!(claim_at_path(&path, 100, 1_000, 7).unwrap());
        assert!(!claim_at_path(&path, 100, 1_050, 8).unwrap());
        assert!(claim_at_path(&path, 100, 1_101, 8).unwrap());
    }

    #[test]
    fn corrupted_lock_is_claimable() {
        let temp = tempdir().unwrap();
        let path = temp.path().join(".watchdog.lock");
        fs::write(&path, b"not json").unwrap();
        assert!(claim_at_path(&path, 100, 1_000, 7).unwrap());
    }
}
