//! Physical JSONL coverage. Only LF commits a record, including after exit.
//! Continuations carry offsets, never an unterminated record's bytes.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

pub const BLOCK: usize = 64 * 1024;
pub const SCAN_BYTES: usize = 2 * 1024 * 1024;
pub const STRUCTURED_BYTES: usize = 1024 * 1024;

pub struct Budget { pub remaining: usize, started: Instant, cached_start: u64, cached_fence: u64, cached: Vec<u8> }
impl Budget {
    pub fn new() -> Self { Self { remaining: SCAN_BYTES, started: Instant::now(), cached_start: u64::MAX, cached_fence: 0, cached: Vec::new() } }
    pub fn available(&self) -> bool { self.remaining > 0 && self.started.elapsed() < Duration::from_millis(50) }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Direction { Older, Newer }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Scan {
    pub direction: Direction,
    pub boundary: u64,
    pub search: u64,
}
impl Scan {
    pub fn older(end: u64) -> Self { Self { direction: Direction::Older, boundary: end, search: end.saturating_sub(1) } }
    pub fn newer(start: u64) -> Self { Self { direction: Direction::Newer, boundary: start, search: start } }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span { pub start: u64, pub end: u64 }
pub enum Next { Record(Span), Pending, End }

pub struct Scanner<'a> {
    file: &'a mut File,
    fence: u64,
    block_start: u64,
    block: Vec<u8>,
}
impl<'a> Scanner<'a> {
    pub fn new(file: &'a mut File, fence: u64) -> Self {
        Self { file, fence, block_start: u64::MAX, block: Vec::new() }
    }
    fn load(&mut self, at: u64, budget: &mut Budget) -> Result<bool, String> {
        if at >= self.block_start && at < self.block_start.saturating_add(self.block.len() as u64) { return Ok(true); }
        if budget.cached_fence == self.fence && at >= budget.cached_start && at < budget.cached_start.saturating_add(budget.cached.len() as u64) {
            self.block_start = budget.cached_start; self.block.clone_from(&budget.cached); return Ok(true);
        }
        if !budget.available() { return Ok(false); }
        let start = at / BLOCK as u64 * BLOCK as u64;
        let len = ((self.fence - start) as usize).min(BLOCK);
        if len > budget.remaining { return Ok(false); }
        self.block.resize(len, 0);
        self.file.seek(SeekFrom::Start(start)).map_err(io_error)?;
        self.file.read_exact(&mut self.block).map_err(io_error)?;
        budget.remaining -= len;
        self.block_start = start;
        budget.cached_start = start; budget.cached_fence = self.fence; budget.cached.clone_from(&self.block);
        Ok(true)
    }
    pub fn next(&mut self, scan: &mut Scan, budget: &mut Budget) -> Result<Next, String> {
        match scan.direction {
            Direction::Older => {
                if scan.boundary == 0 { return Ok(Next::End); }
                while scan.search > 0 {
                    if !self.load(scan.search - 1, budget)? { return Ok(Next::Pending); }
                    let end = (scan.search - self.block_start) as usize;
                    if let Some(i) = self.block[..end].iter().rposition(|b| *b == b'\n') {
                        let start = self.block_start + i as u64 + 1;
                        let span = Span { start, end: scan.boundary };
                        *scan = Scan::older(start);
                        return Ok(Next::Record(span));
                    }
                    scan.search = self.block_start;
                }
                let span = Span { start: 0, end: scan.boundary };
                *scan = Scan::older(0);
                Ok(Next::Record(span))
            }
            Direction::Newer => {
                while scan.search < self.fence {
                    if !self.load(scan.search, budget)? { return Ok(Next::Pending); }
                    let first = (scan.search - self.block_start) as usize;
                    if let Some(i) = self.block[first..].iter().position(|b| *b == b'\n') {
                        let end = scan.search + i as u64 + 1;
                        let span = Span { start: scan.boundary, end };
                        *scan = Scan::newer(end);
                        return Ok(Next::Record(span));
                    }
                    scan.search = self.block_start + self.block.len() as u64;
                }
                // The fence is sampled at a complete LF; an incomplete suffix
                // is only used by the separate fence search, never projection.
                Ok(Next::End)
            }
        }
    }
}

pub fn read_span(file: &mut File, span: Span, budget: &mut Budget) -> Result<Option<Vec<u8>>, String> {
    let len = usize::try_from(span.end - span.start).map_err(|_| "sourceChanged".to_string())?;
    if len > STRUCTURED_BYTES { return Ok(None); }
    if len > budget.remaining || !budget.available() { return Err("slicePending".into()); }
    let mut bytes = vec![0; len];
    file.seek(SeekFrom::Start(span.start)).map_err(io_error)?;
    file.read_exact(&mut bytes).map_err(io_error)?;
    budget.remaining -= len;
    Ok(Some(bytes))
}

pub fn io_error(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => "permissionDenied",
        std::io::ErrorKind::NotFound => "recordMissing",
        _ => "sourceChanged",
    }.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn file(bytes: &[u8]) -> File {
        let mut f = tempfile::tempfile().unwrap(); f.write_all(bytes).unwrap(); f
    }
    #[test]
    fn forward_and_reverse_physical_coverage_match_across_crlf_utf8_and_blocks() {
        let mut bytes = "\n{\"text\":\"日本語 🧑\"}\r\n".as_bytes().to_vec();
        bytes.extend(vec![b'x'; BLOCK * 3 + 7]); bytes.push(b'\n');
        let mut f = file(&bytes);
        let mut forward = Vec::new(); let mut reverse = Vec::new();
        for (direction, out) in [(Direction::Newer, &mut forward), (Direction::Older, &mut reverse)] {
            let mut scan = if direction == Direction::Newer { Scan::newer(0) } else { Scan::older(bytes.len() as u64) };
            loop {
                let mut budget = Budget::new();
                let mut reader = Scanner::new(&mut f, bytes.len() as u64);
                match reader.next(&mut scan, &mut budget).unwrap() {
                    Next::Record(span) => out.push(span), Next::Pending => continue, Next::End => break,
                }
            }
        }
        reverse.reverse(); assert_eq!(forward, reverse);
        assert_eq!(forward[0], Span { start: 0, end: 1 });
        assert_eq!(forward.last().unwrap().end, bytes.len() as u64);
    }
    #[test]
    fn giant_line_continuation_has_constant_resident_state() {
        let mut f = file(&vec![b'x'; SCAN_BYTES * 3]);
        let mut scan = Scan::older((SCAN_BYTES * 3) as u64);
        let mut budget = Budget::new();
        assert!(matches!(Scanner::new(&mut f, (SCAN_BYTES * 3) as u64).next(&mut scan, &mut budget).unwrap(), Next::Pending));
        assert!(scan.search < scan.boundary);
        assert!(serde_json::to_vec(&scan).unwrap().len() < 160);
    }
}
