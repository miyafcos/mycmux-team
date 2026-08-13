//! Bounded JSONL streaming primitives used for transcript files.
use std::io::{BufRead, BufReader, Read};
use std::ops::ControlFlow;
use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub struct Budget { pub max_bytes: u64, pub max_lines: u64 }
#[derive(Debug, Clone, Copy, Default)]
pub struct Stats { pub bytes_read: u64, pub file_bytes: u64, pub lines_read: u64, pub scan_truncated: bool }

pub fn for_each_line(path: &Path, budget: Budget, mut f: impl FnMut(&str) -> ControlFlow<()>) -> Result<Stats, String> {
    let file_bytes = std::fs::metadata(path).map_err(|err| format!("stat transcript {path:?}: {err}"))?.len();
    let file = std::fs::File::open(path).map_err(|err| format!("open transcript {path:?}: {err}"))?;
    let mut reader = BufReader::new(file); let mut buffer = Vec::new(); let mut stats = Stats { file_bytes, ..Stats::default() };
    const MAX_LINE_BYTES: u64 = 1024 * 1024;
    loop {
        if stats.lines_read >= budget.max_lines || stats.bytes_read >= budget.max_bytes {
            stats.scan_truncated = stats.bytes_read < file_bytes;
            break;
        }
        let remaining = (budget.max_bytes - stats.bytes_read).min(MAX_LINE_BYTES);
        buffer.clear();
        let count = (&mut reader)
            .take(remaining)
            .read_until(b'\n', &mut buffer)
            .map_err(|err| format!("read transcript {path:?}: {err}"))?;
        if count == 0 { break; }
        if !buffer.ends_with(b"\n") && count as u64 == remaining {
            stats.scan_truncated = true;
            break;
        }
        stats.lines_read += 1; stats.bytes_read += count as u64;
        if f(&String::from_utf8_lossy(&buffer)).is_break() { stats.scan_truncated = true; break; }
    }
    Ok(stats)
}
