//! Read-only archive leases. Intentionally independent of operational summaries.
//! Sources are append-only logical snapshots, not filesystem transactions.
use std::collections::{HashMap, VecDeque};
use std::fs::{File, ReadDir};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicUsize, Ordering}};
use std::time::{Duration, Instant, SystemTime};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use super::archive_projection::{bounded_value, check_identity, project, turn_key, Draft, PairContext};
use super::adapter::is_injected_user_text;
use super::archive_scan::{Budget, Direction, Next, Scan, Scanner, Span, BLOCK, STRUCTURED_BYTES, io_error, read_span};
use super::sha256_hex;

const REPLY_BYTES: usize = 512 * 1024;
const PREVIEW_BYTES: usize = 8 * 1024;
const BODY_BYTES: usize = 32 * 1024;
const MAX_READERS: usize = 8;
const TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub pty_session_id: String,
    pub tab_id: String,
    pub expected_agent_kind: String,
    pub expected_agent_session_id: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub occurrence_id: String,
    pub source_start: String,
    pub source_end: String,
    pub slot: u32,
    pub kind: String,
    pub timestamp: Option<i64>,
    pub text: String,
    pub body_ref: Option<String>,
    pub call_id: Option<String>,
    pub tool: Option<String>,
    pub target: Option<String>,
    pub aliases: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic { pub reason: String, pub source_start: String, pub source_end: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub reader_id: String,
    pub source_generation: String,
    pub snapshot_end: String,
    pub items: Vec<Item>,
    pub older_cursor: Option<String>,
    pub newer_cursor: Option<String>,
    pub latest_cursor: Option<String>,
    pub scan_continuation: Option<String>,
    pub reached_start: bool,
    pub reached_fence: bool,
    pub diagnostics: Vec<Diagnostic>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest { pub reader_id: String, pub cursor: String, pub limit: Option<usize> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyPage { pub text: String, pub cursor: Option<String>, pub source_text: bool, pub validation_pending: bool }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Heartbeat { pub has_new_bytes: bool }

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Position {
    boundary: u64, record_end: Option<u64>, slot: Option<u32>,
    // Exceptional block indexes are not limited by structured JSON admission.
    // Their signed extraction span stays inside the signed complete record.
    #[serde(default,skip_serializing_if="Option::is_none")]
    raw_part: Option<(u64,u64)>,
}
impl Position { fn at(boundary: u64) -> Self { Self { boundary, record_end: None, slot: None, raw_part: None } } }
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op")]
enum Token {
    Page { generation: String, fence: u64, anchor: String, direction: Direction, position: Position },
    Continue { job: String },
    VerifyBody { job: String },
    Body { generation: String, start: u64, end: u64, slot: u32, raw: bool, hash: String, #[serde(default,skip_serializing_if="Option::is_none")] part: Option<(u64,u64)> },
}

struct Discovery { root: PathBuf, stack: Vec<ReadDir>, candidate: Option<PathBuf> }
impl Discovery {
    fn new(root: PathBuf) -> Result<Self, String> {
        let root = root.canonicalize().map_err(io_error)?;
        let entries = std::fs::read_dir(&root).map_err(io_error)?;
        Ok(Self { root, stack: vec![entries], candidate: None })
    }
    fn step(&mut self, kind: &str, id: &str, budget: &mut Budget) -> Result<Option<PathBuf>, String> {
        let mut entries = 0usize;
        while budget.available() && entries < 2048 {
            let Some(dir) = self.stack.last_mut() else { return self.candidate.clone().map(Some).ok_or("recordMissing".into()); };
            let Some(entry) = dir.next() else { self.stack.pop(); continue; };
            let entry = entry.map_err(io_error)?; entries += 1;
            let ty = entry.file_type().map_err(io_error)?;
            // Never follow directory/file symlinks, including within the root.
            if ty.is_symlink() { continue; }
            if ty.is_dir() {
                if self.stack.len() >= 64 { return Err("ambiguousSource".into()); }
                self.stack.push(std::fs::read_dir(entry.path()).map_err(io_error)?);
            } else if ty.is_file() {
                let name = entry.file_name(); let name = name.to_string_lossy();
                let matches = if kind == "codex" { name.strip_suffix(".jsonl").is_some_and(|stem| stem.strip_suffix(id).is_some_and(|prefix| prefix.ends_with('-'))) }
                    else { name == format!("{id}.jsonl") };
                if matches {
                    let path = entry.path().canonicalize().map_err(io_error)?;
                    if !path.starts_with(&self.root) { return Err("identityMismatch".into()); }
                    // Ambiguous copies are deliberately refused, even if identical.
                    if self.candidate.is_some() { return Err("ambiguousSource".into()); }
                    self.candidate = Some(path);
                }
            }
        }
        Ok(None)
    }
}

#[derive(Clone)]
struct Fingerprint { start: u64, end: u64, hash: String }
// The active turn is a fixed-size digest; provider strings never accumulate.
struct TurnHint { start: u64, end: u64, turn: Option<String> }
struct Source { generation: String, key: String, invalid: AtomicBool, spans: Mutex<VecDeque<Fingerprint>>, turns: Mutex<VecDeque<TurnHint>> }
struct Opened {
    file: File, path: PathBuf, identity: String, source: Arc<Source>,
    head: Fingerprint, fence: u64, anchor: String, length: u64, modified: Option<SystemTime>, incomplete: bool,
}
struct Candidate { item: Item, digest: Option<String>, suppressed: bool }
struct ContextJob { search: Scan, reset: Option<u64>, turn: Option<String>, turn_seen: bool, ready: bool, replay: Scan, context: PairContext }
struct RawCheck { span: Span, at: u64, hash: Sha256, probe: IdentityProbe }
struct BodyCheck { id: String, reference: String, at: u64, offset: usize, hash: Sha256 }
struct Job {
    id: String, base: String, direction: Direction, fence: u64, anchor: String,
    start: Position, position: Position, scan: Scan, limit: usize,
    items: Vec<Candidate>, bytes: usize, done: bool,
    context: Option<ContextJob>, raw: Option<RawCheck>,
}
struct TailSearch { id: String, base: String, generation: String, fence: u64, anchor: String, position: Position, eof: u64, at: u64 }
struct Reader {
    id: String, owner: String, descriptor: Descriptor, secret: String,
    cache_key: String, root: PathBuf,
    used: Instant, closed: Arc<AtomicBool>, discovery: Option<Discovery>, opened: Option<Opened>,
    fence_search: Option<u64>, tail_search: Option<TailSearch>, job: Option<Job>, last: Option<(String, Page)>,
    body_check: Option<BodyCheck>, verified_body: Option<String>,
}
struct Lease { owner: String, closed: Arc<AtomicBool>, reader: Arc<Mutex<Reader>> }
#[derive(Default)]
struct Registry {
    readers: HashMap<String, Lease>,
    sources: Vec<std::sync::Weak<Source>>,
    paths: VecDeque<(String, PathBuf, Instant)>,
    accepted: VecDeque<(String, Descriptor)>,
}
// Production shares one state across all windows. Tests inject their own state
// into the same implementation, including discovery, leases and job admission.
#[derive(Default)]
struct ArchiveState { registry: Mutex<Registry>, jobs: AtomicUsize }
fn state() -> &'static ArchiveState {
    static STATE: OnceLock<ArchiveState> = OnceLock::new();
    STATE.get_or_init(ArchiveState::default)
}
struct Admission<'a> { jobs: &'a AtomicUsize }
impl<'a> Admission<'a> {
    fn enter(jobs: &'a AtomicUsize) -> Result<Self, String> {
        if jobs.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < 2).then_some(n + 1)).is_err() { return Err("readerBusy".into()); }
        Ok(Self { jobs })
    }
}
impl Drop for Admission<'_> { fn drop(&mut self) { self.jobs.fetch_sub(1, Ordering::SeqCst); } }

pub fn safe_id(kind: &str, id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        && (kind != "codex" || Uuid::parse_str(id).is_ok())
}
pub fn accepted(owner: &str, descriptor: &Descriptor) -> bool { state().accepted(owner, descriptor) }
pub fn descriptor(owner: &str, id: &str) -> Result<Descriptor, String> { state().descriptor(owner, id) }
pub fn heartbeat(owner: &str, id: &str) -> Result<Heartbeat, String> { state().heartbeat(owner, id) }
pub fn open(owner: &str, descriptor: Descriptor, root: PathBuf) -> Result<Page, String> { state().open(owner, descriptor, root) }
pub fn page(owner: &str, request: PageRequest) -> Result<Page, String> { state().page(owner, request) }
pub fn refresh(owner: &str, id: &str, after: &str) -> Result<Page, String> { state().refresh(owner, id, after) }
pub fn close(owner: &str, id: &str) { state().close(owner, id); }
pub fn close_window(owner: &str) { state().close_window(owner); }
pub fn body(owner: &str, id: &str, body_ref: &str, cursor: Option<&str>) -> Result<BodyPage, String> { state().body(owner, id, body_ref, cursor) }

impl ArchiveState {
    fn accepted(&self, owner: &str, descriptor: &Descriptor) -> bool {
        self.registry.lock().unwrap_or_else(|p| p.into_inner()).accepted.iter().any(|(w, d)| w == owner && d == descriptor)
    }
    fn descriptor(&self, owner: &str, id: &str) -> Result<Descriptor, String> {
        let reader = self.lease(owner,id)?; let r = reader.try_lock().map_err(|_| "readerBusy".to_string())?; Ok(r.descriptor.clone())
    }
    fn heartbeat(&self, owner: &str, id: &str) -> Result<Heartbeat, String> {
        let _admission=Admission::enter(&self.jobs)?; let reader=self.lease(owner,id)?;
        let mut r=reader.try_lock().map_err(|_|"readerBusy".to_string())?; r.used=Instant::now();
        if let Some(o)=&r.opened { let generation=o.source.generation.clone(); let fence=o.fence; let anchor=o.anchor.clone(); r.validate(&generation,fence,&anchor)?; }
        Ok(Heartbeat { has_new_bytes:r.opened.as_ref().is_some_and(|o|o.length>o.fence) })
    }
    fn open(&self, owner: &str, descriptor: Descriptor, root: PathBuf) -> Result<Page, String> {
        let _admission = Admission::enter(&self.jobs)?;
        let kind = &descriptor.expected_agent_kind; let id = &descriptor.expected_agent_session_id;
        if !matches!(kind.as_str(), "claude" | "claude-codex" | "codex") { return Err("unsupportedAgent".into()); }
        if !safe_id(kind, id) { return Err("identityMismatch".into()); }
        let root = root.canonicalize().map_err(io_error)?;
        let key = format!("{}:{kind}:{id}", root.display());
        let cached = {
            let mut r = self.registry.lock().unwrap_or_else(|p| p.into_inner());
            r.readers.retain(|_, lease| lease.reader.try_lock().map(|r| { let keep = r.used.elapsed() < TTL; if !keep { lease.closed.store(true, Ordering::SeqCst); } keep }).unwrap_or(true));
            if r.readers.len() >= MAX_READERS { return Err("readerBusy".into()); }
            r.paths.iter().find(|(k, _, used)| k == &key && used.elapsed() < Duration::from_secs(30)).map(|(_, p, _)| p.clone())
        };
        let mut reader = Reader { id: Uuid::new_v4().to_string(), owner: owner.into(), descriptor, secret: Uuid::new_v4().to_string(), cache_key: key, root: root.clone(), used: Instant::now(), closed: Arc::new(AtomicBool::new(false)), discovery: None, opened: None, fence_search: None, tail_search: None, job: None, last: None, body_check: None, verified_body: None };
        if let Some(path) = cached {
            let canonical_root = root.canonicalize().map_err(io_error)?;
            if std::fs::symlink_metadata(&path).map_err(io_error)?.file_type().is_symlink() || !path.canonicalize().map_err(io_error)?.starts_with(canonical_root) { return Err("identityMismatch".into()); }
            reader.attach(self, path)?;
        } else { reader.discovery = Some(Discovery::new(root)?); }
        let reader_id = reader.id.clone();
        let closed = reader.closed.clone(); let reader = Arc::new(Mutex::new(reader));
        { let mut registry = self.registry.lock().unwrap_or_else(|p| p.into_inner()); if registry.readers.len() >= MAX_READERS { return Err("readerBusy".into()); } registry.readers.insert(reader_id.clone(), Lease { owner: owner.into(), closed, reader: reader.clone() }); }
        let result = reader.lock().unwrap_or_else(|p| p.into_inner()).initial(self);
        if result.is_err() { self.close(owner, &reader_id); }
        result
    }
    fn lease(&self, owner: &str, id: &str) -> Result<Arc<Mutex<Reader>>, String> {
        let reader = { let registry = self.registry.lock().unwrap_or_else(|p| p.into_inner()); let lease = registry.readers.get(id).ok_or("cursorExpired".to_string())?; if lease.owner != owner || lease.closed.load(Ordering::SeqCst) { return Err("cursorExpired".into()); } lease.reader.clone() };
        {
            let r = reader.try_lock().map_err(|_| "readerBusy".to_string())?;
            if r.owner != owner { return Err("cursorExpired".into()); }
            if r.used.elapsed() >= TTL || r.closed.load(Ordering::SeqCst) { return Err("cursorExpired".into()); }
        }
        Ok(reader)
    }
    fn page(&self, owner: &str, request: PageRequest) -> Result<Page, String> {
        let _admission = Admission::enter(&self.jobs)?;
        let reader = self.lease(owner, &request.reader_id)?;
        let mut r = reader.try_lock().map_err(|_| "readerBusy".to_string())?;
        r.used = Instant::now();
        if let Some((base, page)) = &r.last {
            if base == &request.cursor {
                let page = page.clone();
                let Token::Page { generation, fence, anchor, .. } = r.decode(page.newer_cursor.as_deref().ok_or("cursorExpired".to_string())?)? else { return Err("cursorExpired".into()); };
                r.validate(&generation, fence, &anchor)?; return Ok(page);
            }
        }
        let token=r.decode(&request.cursor)?;let continuation=matches!(token,Token::Continue{..});
        let result=match token {
            Token::Continue { job } => {
                if let Some(tail) = &r.tail_search {
                    if tail.id != job { return Err("cursorExpired".into()); }
                    return r.advance_tail(&mut Budget::new());
                }
                if r.job.as_ref().is_some_and(|j| j.id != job) { return Err("cursorExpired".into()); }
                if r.opened.is_none() || r.fence_search.is_some() { r.initial(self) } else { r.advance() }
            }
            Token::Page { generation, fence, anchor, direction, position } => {
                if r.job.is_some() || r.tail_search.is_some() { return Err("readerBusy".into()); }
                r.validate(&generation, fence, &anchor)?;
                r.validate_position(&position, fence)?;
                r.start_job(request.cursor.clone(), direction, fence, anchor, position, request.limit.unwrap_or(100).clamp(1,200));
                r.advance()
            }
            _ => Err("cursorExpired".into()),
        };
        if continuation { if let Ok(page)=&result { if page.scan_continuation.is_none() {r.last=Some((request.cursor,page.clone()));} } }
        result
    }
    fn refresh(&self, owner: &str, id: &str, after: &str) -> Result<Page, String> {
        let _admission = Admission::enter(&self.jobs)?;
        let reader = self.lease(owner, id)?;
        let mut r = reader.try_lock().map_err(|_| "readerBusy".to_string())?;
        r.used = Instant::now();
        if r.job.is_some() || r.tail_search.is_some() { return Err("readerBusy".into()); }
        let Token::Page { generation, fence, anchor, position, .. } = r.decode(after)? else { return Err("cursorExpired".into()); };
        r.validate(&generation, fence, &anchor)?; r.validate_position(&position, fence)?;
        let eof = r.opened.as_ref().ok_or("cursorExpired".to_string())?.file.metadata().map_err(io_error)?.len();
        r.tail_search = Some(TailSearch { id: Uuid::new_v4().to_string(), base: after.into(), generation, fence, anchor, position, eof, at: eof });
        r.advance_tail(&mut Budget::new())
    }
    fn close(&self, owner: &str, id: &str) {
        let mut registry = self.registry.lock().unwrap_or_else(|p| p.into_inner());
        if registry.readers.get(id).is_some_and(|r| r.owner == owner) { if let Some(r) = registry.readers.remove(id) { r.closed.store(true, Ordering::SeqCst); } }
    }
    fn close_window(&self, owner: &str) {
        let ids = self.registry.lock().unwrap_or_else(|p| p.into_inner()).readers.iter().filter(|(_,r)| r.owner == owner).map(|(id,_)| id.clone()).collect::<Vec<_>>();
        for id in ids { self.close(owner, &id); }
        self.registry.lock().unwrap_or_else(|p| p.into_inner()).accepted.retain(|(w,_)| w != owner);
    }
}

impl Reader {
    fn advance_tail(&mut self, budget: &mut Budget) -> Result<Page, String> {
        let mut tail = self.tail_search.take().ok_or("cursorExpired".to_string())?;
        self.validate(&tail.generation, tail.fence, &tail.anchor)?;
        let o = self.opened.as_mut().ok_or("cursorExpired".to_string())?;
        let Some(fence) = find_fence(&mut o.file, tail.eof, &mut tail.at, budget)? else {
            let cursor = self.encode(Token::Continue { job: tail.id.clone() });
            self.tail_search = Some(tail);
            return Ok(self.empty(Some(cursor), "contextPending"));
        };
        if fence < tail.fence { return Err("sourceChanged".into()); }
        let anchor = fingerprint(&mut o.file, fence.saturating_sub(256), fence)?.hash;
        o.fence = fence; o.anchor = anchor.clone(); o.incomplete = fence < o.length;
        self.start_job(tail.base, Direction::Newer, fence, anchor, tail.position, 100);
        self.advance_budget(budget)
    }
    fn encode(&self, token: Token) -> String {
        let bytes = serde_json::to_vec(&token).expect("archive token");
        let payload = URL_SAFE_NO_PAD.encode(bytes);
        let mac = sha256_hex(format!("{}:{}:{}:{}", self.secret, self.id, payload, self.secret).as_bytes());
        format!("1.{payload}.{mac}")
    }
    fn decode(&self, cursor: &str) -> Result<Token, String> {
        if cursor.len() > 4096 { return Err("cursorExpired".into()); }
        let parts = cursor.split('.').collect::<Vec<_>>();
        if parts.len() != 3 || parts[0] != "1" { return Err("cursorExpired".into()); }
        let mac = sha256_hex(format!("{}:{}:{}:{}", self.secret, self.id, parts[1], self.secret).as_bytes());
        if mac != parts[2] { return Err("cursorExpired".into()); }
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| "cursorExpired".to_string())?).map_err(|_| "cursorExpired".into())
    }
    fn attach(&mut self, state: &ArchiveState, path: PathBuf) -> Result<(), String> {
        let mut file = File::open(&path).map_err(io_error)?;
        let identity = file_identity(&file)?;
        let metadata = file.metadata().map_err(io_error)?;
        let head = fingerprint(&mut file, 0, metadata.len().min(256))?;
        let key = format!("{}:{}:{identity}", self.descriptor.expected_agent_kind, self.descriptor.expected_agent_session_id);
        let source = {
            let mut r = state.registry.lock().unwrap_or_else(|p| p.into_inner());
            r.sources.retain(|s| s.strong_count() > 0);
            let source = r.sources.iter().filter_map(|s| s.upgrade()).find(|s| s.key == key && !s.invalid.load(Ordering::SeqCst));
            source.unwrap_or_else(|| { let source = Arc::new(Source { generation: Uuid::new_v4().to_string(), key, invalid: AtomicBool::new(false), spans: Mutex::new(VecDeque::new()), turns: Mutex::new(VecDeque::new()) }); r.sources.push(Arc::downgrade(&source)); source })
        };
        self.fence_search = Some(metadata.len());
        self.opened = Some(Opened { file, path, identity, source, head, fence: 0, anchor: sha256_hex(b""), length: metadata.len(), modified: metadata.modified().ok(), incomplete: false });
        Ok(())
    }
    fn empty(&self, continuation: Option<String>, reason: &str) -> Page {
        let (generation, fence) = self.opened.as_ref().map(|o| (o.source.generation.clone(), o.fence)).unwrap_or_default();
        Page { reader_id: self.id.clone(), source_generation: generation, snapshot_end: fence.to_string(), items: Vec::new(), older_cursor: None, newer_cursor: None, latest_cursor: None, scan_continuation: continuation, reached_start: false, reached_fence: false, diagnostics: vec![Diagnostic { reason: reason.into(), source_start: "0".into(), source_end: fence.to_string() }] }
    }
    fn initial(&mut self, state: &ArchiveState) -> Result<Page, String> {
        let mut budget = Budget::new();
        if let Some(o) = &self.opened { let generation=o.source.generation.clone(); let fence=o.fence; let anchor=o.anchor.clone(); self.validate(&generation,fence,&anchor)?; }
        if let Some(discovery) = &mut self.discovery {
            if let Some(path) = discovery.step(&self.descriptor.expected_agent_kind, &self.descriptor.expected_agent_session_id, &mut budget)? {
                self.attach(state, path.clone())?; self.discovery = None;
                let mut r = state.registry.lock().unwrap_or_else(|p| p.into_inner());
                if r.paths.len() >= 64 { r.paths.pop_front(); }
                r.paths.push_back((self.cache_key.clone(), path, Instant::now()));
            } else { return Ok(self.empty(Some(self.encode(Token::Continue { job: "initial".into() })), "locatingRecord")); }
        }
        let o = self.opened.as_mut().ok_or("recordMissing".to_string())?;
        let search = self.fence_search.as_mut().ok_or("cursorExpired".to_string())?;
        let Some(fence) = find_fence(&mut o.file, o.length, search, &mut budget)? else { return Ok(self.empty(Some(self.encode(Token::Continue { job: "initial".into() })), "incompleteRecord")); };
        o.fence = fence; o.incomplete=fence<o.length; o.anchor = fingerprint(&mut o.file, fence.saturating_sub(256), fence)?.hash;
        // Codex's own id is required in the FIRST complete record; parent/root
        // metadata is never a replacement, and header work is strictly bounded.
        if self.descriptor.expected_agent_kind == "codex" && fence == 0 {
            let metadata=o.file.metadata().map_err(io_error)?;o.length=metadata.len();o.modified=metadata.modified().ok();self.fence_search = Some(o.length);
            return Ok(self.empty(Some(self.encode(Token::Continue { job: "initial".into() })), "incompleteRecord"));
        }
        if self.descriptor.expected_agent_kind == "codex" {
            let mut scan = Scan::newer(0); let next = Scanner::new(&mut o.file, fence).next(&mut scan, &mut budget)?;
            let Next::Record(span) = next else { return Ok(self.empty(Some(self.encode(Token::Continue { job: "initial".into() })), "contextPending")); };
            let raw = match read_span(&mut o.file, span, &mut budget) { Ok(Some(raw)) => raw, Ok(None) => return Err("identityMismatch".into()), Err(e) if e == "slicePending" => return Ok(self.empty(Some(self.encode(Token::Continue { job: "initial".into() })), "contextPending")), Err(e) => return Err(e) };
            let v = bounded_value(&raw).map_err(|_| "identityMismatch".to_string())?;
            if v["type"] != "session_meta" || v["payload"]["id"].as_str() != Some(self.descriptor.expected_agent_session_id.as_str()) { return Err("identityMismatch".into()); }
        }
        self.fence_search = None;
        let anchor = self.opened.as_ref().unwrap().anchor.clone();
        self.start_job("initial".into(), Direction::Older, fence, anchor, Position::at(fence), 100);
        let mut registry = state.registry.lock().unwrap_or_else(|p| p.into_inner());
        if registry.accepted.len() >= 64 { registry.accepted.pop_front(); }
        registry.accepted.push_back((self.owner.clone(), self.descriptor.clone()));
        drop(registry);
        self.advance_budget(&mut budget)
    }
    fn validate(&mut self, generation: &str, fence: u64, anchor: &str) -> Result<(), String> {
        let o = self.opened.as_mut().ok_or("cursorExpired".to_string())?;
        if generation != o.source.generation { return Err("cursorExpired".into()); }
        if o.source.invalid.load(Ordering::SeqCst) { return Err("sourceChanged".into()); }
        let metadata = o.file.metadata().map_err(io_error)?;
        if !o.path.canonicalize().map_err(io_error)?.starts_with(&self.root) || std::fs::symlink_metadata(&o.path).map_err(io_error)?.file_type().is_symlink() { o.source.invalid.store(true, Ordering::SeqCst); return Err("sourceChanged".into()); }
        let path_file = File::open(&o.path).map_err(io_error)?;
        let changed = metadata.len() < fence || metadata.len() < o.length || file_identity(&path_file)? != o.identity
            || (metadata.len() == o.length && metadata.modified().ok() != o.modified)
            || fingerprint(&mut o.file, o.head.start, o.head.end)?.hash != o.head.hash
            || fingerprint(&mut o.file, fence.saturating_sub(256), fence)?.hash != anchor;
        if changed { o.source.invalid.store(true, Ordering::SeqCst); return Err("sourceChanged".into()); }
        o.length = metadata.len(); o.modified = metadata.modified().ok();
        Ok(())
    }
    fn validate_position(&mut self, p: &Position, fence: u64) -> Result<(), String> {
        if p.boundary > fence || p.record_end.is_some_and(|e| e > fence || e <= p.boundary)
            || p.slot.is_some() && p.record_end.is_none() { return Err("cursorExpired".into()); }
        if let Some((start,end))=p.raw_part {
            if p.slot.is_none() || start < p.boundary || end <= start || p.record_end.is_none_or(|record_end|end > record_end) { return Err("cursorExpired".into()); }
        } else if p.slot.is_some_and(|s|s > 4097) { return Err("cursorExpired".into()); }
        let o = self.opened.as_mut().ok_or("cursorExpired".to_string())?;
        for offset in [p.boundary, p.record_end.unwrap_or(p.boundary)] {
            if offset > 0 { let f = fingerprint(&mut o.file, offset-1, offset)?; if f.hash != sha256_hex(b"\n") { return Err("cursorExpired".into()); } }
        }
        Ok(())
    }
    fn start_job(&mut self, base: String, direction: Direction, fence: u64, anchor: String, position: Position, limit: usize) {
        let scan = if direction == Direction::Older { Scan::older(position.boundary) } else { Scan::newer(position.boundary) };
        self.job = Some(Job { id: Uuid::new_v4().to_string(), base, direction, fence, anchor, start: position.clone(), position, scan, limit, items: Vec::new(), bytes: 0, done: false, context: None, raw: None });
    }
    fn advance(&mut self) -> Result<Page, String> {
        self.advance_budget(&mut Budget::new())
    }
    fn advance_budget(&mut self, budget: &mut Budget) -> Result<Page, String> {
        let mut job = self.job.take().ok_or("cursorExpired".to_string())?;
        let generation = self.opened.as_ref().unwrap().source.generation.clone();
        self.validate(&generation, job.fence, &job.anchor)?;
        let result = self.collect(&mut job, budget).and_then(|_| self.resolve_context(&mut job, budget));
        if let Err(error) = result { if error == "identityMismatch" { self.opened.as_ref().unwrap().source.invalid.store(true, Ordering::SeqCst); } return Err(error); }
        let ready = job.done && job.context.as_ref().is_none_or(|c| c.ready);
        let mut items = job.items.iter().filter(|c| !c.suppressed && (c.digest.is_none() || ready)).map(|c| c.item.clone()).collect::<Vec<_>>();
        items.sort_by_key(|i| (i.source_start.parse::<u64>().unwrap_or(0), i.slot));
        let older_pos = if job.direction == Direction::Older { job.position.clone() } else { opposite_position(&job.start, Direction::Older) };
        let newer_pos = if job.direction == Direction::Newer { job.position.clone() } else { opposite_position(&job.start, Direction::Newer) };
        let reached_start = ready && older_pos.boundary == 0 && older_pos.record_end.is_none();
        let reached_fence = ready && newer_pos.boundary == job.fence && newer_pos.record_end.is_none();
        let cursor = |direction, position: Position| self.encode(Token::Page { generation: generation.clone(), fence: job.fence, anchor: job.anchor.clone(), direction, position });
        let page = Page { reader_id: self.id.clone(), source_generation: generation.clone(), snapshot_end: job.fence.to_string(), items,
            older_cursor: if ready && !reached_start { Some(cursor(Direction::Older, older_pos)) } else { None },
            // Always retain a forward anchor, including at the current fence.
            newer_cursor: if ready { Some(cursor(Direction::Newer, newer_pos)) } else { None },
            latest_cursor: if ready { Some(cursor(Direction::Older, Position::at(job.fence))) } else { None },
            scan_continuation: if ready { None } else { Some(self.encode(Token::Continue { job: job.id.clone() })) }, reached_start, reached_fence,
            diagnostics: if ready { if self.opened.as_ref().unwrap().incomplete { vec![Diagnostic { reason:"incompleteRecord".into(),source_start:self.opened.as_ref().unwrap().fence.to_string(),source_end:self.opened.as_ref().unwrap().length.to_string() }] }else{Vec::new()} } else { vec![Diagnostic { reason: "contextPending".into(), source_start: job.position.boundary.to_string(), source_end: job.fence.to_string() }] } };
        if ready { self.last = Some((job.base, page.clone())); } else { self.job = Some(job); }
        Ok(page)
    }
    fn collect(&mut self, job: &mut Job, budget: &mut Budget) -> Result<(), String> {
        while !job.done && budget.available() && !self.closed.load(Ordering::SeqCst) {
            if let Some(raw) = &mut job.raw {
                let o = self.opened.as_mut().unwrap();
                let len = ((raw.span.end - raw.at) as usize).min(BLOCK).min(budget.remaining);
                if len == 0 { return Ok(()); }
                let bytes = read_bytes(&mut o.file, raw.at, len)?; raw.hash.update(&bytes); raw.probe.feed(&bytes); raw.at += len as u64; budget.remaining -= len;
                if raw.at == raw.span.end {
                    raw.probe.finish(); raw.probe.check(&self.descriptor)?;
                    let raw = job.raw.take().unwrap(); let hash = hex::encode(raw.hash.finalize());
                    validate_span(&self.opened.as_ref().unwrap().source, raw.span, &hash)?;
                    if !raw.probe.sidechain {
                        let excluded = self.descriptor.expected_agent_kind != "codex" && raw.probe.outer.as_deref() == Some("user")
                            && (raw.probe.meta || is_injected_user_text(&raw.probe.user_prefix.text));
                        if excluded {
                            let mut parts = raw.probe.parts;
                            if job.direction == Direction::Older { parts.reverse(); }
                            for (part, draft) in parts {
                                let safe_part=Span{start:raw.span.start+part.start,end:raw.span.start+part.end};
                                if !self.add(job, raw.span, &draft, &hash, part.end-part.start>PREVIEW_BYTES as u64, Some(safe_part))? {job.done=true;return Ok(());}
                                job.position.slot=Some(draft.slot);job.position.raw_part=Some((safe_part.start,safe_part.end));
                                if job.items.len()>=job.limit {job.done=true;return Ok(());}
                            }
                            if raw.probe.more_parts {job.done=true;return Ok(());}
                        } else {
                            let draft = Draft { slot: 0, kind: "source", text: "大きい記録・読み取れない記録（元の記録を表示）".into(), timestamp: None, call_id: None, tool: None, target: None, aliases: Vec::new(), user_form: None, legacy_index: None };
                            if !self.add(job, raw.span, &draft, &hash, true, None)? { job.done = true; return Ok(()); }
                        }
                    }
                    self.finish_record(job, raw.span);
                }
                continue;
            }
            let span = if let Some(end) = job.position.record_end { Span { start: job.position.boundary, end } } else {
                let o = self.opened.as_mut().unwrap();
                match Scanner::new(&mut o.file, job.fence).next(&mut job.scan, budget)? {
                    Next::Record(span) => { job.position = Position { boundary: span.start, record_end: Some(span.end), slot: None, raw_part: None }; span }
                    Next::Pending => return Ok(()), Next::End => { job.done = true; break; }
                }
            };
            let o = self.opened.as_mut().unwrap();
            let raw = match read_span(&mut o.file, span, budget) { Ok(raw) => raw, Err(e) if e == "slicePending" => return Ok(()), Err(e) => return Err(e) };
            if let Some(raw) = raw {
                if raw.iter().all(|b| b.is_ascii_whitespace()) { self.finish_record(job, span); continue; }
                let value = match bounded_value(&raw) { Ok(v) => v, Err(_) => { job.raw = Some(RawCheck { span, at: span.start, hash: Sha256::new(), probe: IdentityProbe::projection(job.direction, job.position.slot) }); continue; } };
                check_identity(&self.descriptor.expected_agent_kind, &self.descriptor.expected_agent_session_id, &value)?;
                let hash = sha256_hex(&raw); validate_span(&o.source, span, &hash)?;
                let mut drafts = project(&self.descriptor.expected_agent_kind, &value);
                if job.direction == Direction::Older { drafts.reverse(); }
                for draft in drafts {
                    if job.position.slot.is_some_and(|slot| if job.direction == Direction::Older { draft.slot >= slot } else { draft.slot <= slot }) { continue; }
                    let raw_source = draft.kind == "diagnostic";
                    if !self.add(job, span, &draft, &hash, raw_source, None)? { job.done = true; return Ok(()); }
                    job.position.slot = Some(draft.slot);job.position.raw_part=None;
                    if job.items.len() >= job.limit { job.done = true; return Ok(()); }
                }
                self.finish_record(job, span);
            } else { job.raw = Some(RawCheck { span, at: span.start, hash: Sha256::new(), probe: IdentityProbe::projection(job.direction, job.position.slot) }); }
        }
        Ok(())
    }
    fn add(&self, job: &mut Job, span: Span, draft: &Draft, hash: &str, raw: bool, part: Option<Span>) -> Result<bool, String> {
        let generation = &self.opened.as_ref().unwrap().source.generation;
        let occurrence_id = format!("{}:{}:{}:{}:{}", self.descriptor.expected_agent_kind, self.descriptor.expected_agent_session_id, generation, span.start, draft.slot);
        let body_ref = (raw || draft.text.len() > PREVIEW_BYTES).then(|| self.encode(Token::Body { generation: generation.clone(), start: span.start, end: span.end, slot: draft.slot, raw, hash: hash.into(), part: part.map(|p|(p.start,p.end)) }));
        let item = Item { occurrence_id, source_start: span.start.to_string(), source_end: span.end.to_string(), slot: draft.slot, kind: draft.kind.into(), timestamp: draft.timestamp,
            text: prefix(&draft.text, PREVIEW_BYTES).into(), body_ref, call_id: draft.call_id.as_ref().map(|s| prefix(s,256).into()), tool: draft.tool.as_ref().map(|s| prefix(s,256).into()), target: draft.target.as_ref().map(|s| prefix(s,1024).into()),
            aliases: draft.aliases.iter().filter(|s| s.len() <= 256).take(4).cloned().chain(draft.legacy_index.map(|n|format!("{}:{}:{n}",span.start,span.end))).collect() };
        let size = serde_json::to_vec(&item).map_err(|_| "sourceChanged".to_string())?.len();
        if job.bytes + size > REPLY_BYTES - 4096 && !job.items.is_empty() { return Ok(false); }
        job.bytes += size;
        job.items.push(Candidate { item, digest: draft.user_form.map(|_| sha256_hex(draft.text.as_bytes())), suppressed: false });
        Ok(true)
    }
    fn finish_record(&self, job: &mut Job, span: Span) {
        job.position = Position::at(if job.direction == Direction::Older { span.start } else { span.end });
        job.scan = if job.direction == Direction::Older { Scan::older(span.start) } else { Scan::newer(span.end) };
        if job.items.len() >= job.limit || job.position.boundary == if job.direction == Direction::Older { 0 } else { job.fence } { job.done = true; }
    }
    fn resolve_context(&mut self, job: &mut Job, budget: &mut Budget) -> Result<(), String> {
        if !job.done || self.descriptor.expected_agent_kind != "codex" { return Ok(()); }
        let first = job.items.iter().filter(|c| c.digest.is_some()).map(|c| c.item.source_start.parse::<u64>().unwrap()).min();
        let Some(first) = first else { return Ok(()); };
        if job.context.is_none() {
            job.context = Some(ContextJob { search: Scan::older(first), reset: None, turn: None, turn_seen: false, ready: false, replay: Scan::newer(0), context: PairContext::selected(job.items.iter().filter_map(|c| c.digest.clone())) });
        }
        let c = job.context.as_mut().unwrap();
        let o = self.opened.as_mut().unwrap();
        // Locate a pair reset and the active turn separately: assistant work
        // clears pairs, but does NOT clear the current turn.
        while !c.ready && c.search.boundary != u64::MAX && budget.available() {
            if let Some(reset) = c.reset.filter(|_| !c.turn_seen) {
                let turn = o.source.turns.lock().unwrap_or_else(|p| p.into_inner()).iter()
                    .find(|h| c.search.boundary >= h.start && c.search.boundary <= h.end)
                    .map(|h| (h.start, h.turn.clone()));
                if let Some((start, turn)) = turn {
                    remember_turn(&o.source, start, first, turn.clone());
                    c.context.turn = turn; c.replay = Scan::newer(reset); c.search.boundary = u64::MAX; break;
                }
            }
            let prior = c.search.clone();
            let span = match Scanner::new(&mut o.file, job.fence).next(&mut c.search, budget)? { Next::Record(s) => s, Next::Pending => return Ok(()), Next::End => {
                // Byte zero does not prove an absent turn: replay may meet a
                // turn that preceded all pairs but no assistant reset.

                c.replay = Scan::newer(c.reset.unwrap_or(0)); c.context.turn = if c.reset.is_some() { c.turn.clone() } else { None }; c.search.boundary = u64::MAX; break;
            } };
            let raw = match read_span(&mut o.file, span, budget) { Ok(v) => v, Err(e) if e == "slicePending" => { c.search = prior; return Ok(()); }, Err(e) => return Err(e) };
            let Some(v) = raw.and_then(|r| bounded_value(&r).ok()) else {
                // Unknown bounded context cannot prove a turn/pair across it.
                // Keep both user occurrences visible rather than invent a pair.
                c.replay = Scan::newer(c.reset.unwrap_or(span.end)); c.context.turn = None; c.search.boundary = u64::MAX; break;
            };
            check_identity("codex", &self.descriptor.expected_agent_session_id, &v)?;
            let p = v.get("payload").unwrap_or(&v); let outer = v["type"].as_str().unwrap_or_default(); let inner = p["type"].as_str().unwrap_or_default();
            if c.reset.is_none() && ((outer == "response_item" && matches!(inner, "message" | "function_call" | "custom_tool_call") && p["role"] != "user") || (outer == "event_msg" && inner == "agent_message")) { c.reset = Some(span.end); }
            if outer == "event_msg" && matches!(inner, "task_complete" | "turn_aborted") {
                if c.reset.is_none() { c.reset = Some(span.end); }
                if !c.turn_seen { remember_turn(&o.source, span.end, first, None); }
                c.replay = Scan::newer(c.reset.unwrap()); c.search.boundary = u64::MAX; break;
            }
            let user = (outer == "event_msg" && inner == "user_message") || (outer == "response_item" && inner == "message" && p["role"] == "user");
            let turn = p["turn_id"].as_str().or(v["turn_id"].as_str()).filter(|s| !s.is_empty());
            if c.reset.is_some() && (outer == "turn_context" || (outer == "event_msg" && inner == "task_started") || (user && turn.is_some())) {
                c.turn = turn.map(turn_key); c.context.turn = c.turn.clone();
                if !c.turn_seen { remember_turn(&o.source, span.end, first, c.turn.clone()); }
                c.replay = Scan::newer(c.reset.unwrap()); c.search.boundary = u64::MAX; break;
            }
            if c.reset.is_none() && (outer == "turn_context" || (outer == "event_msg" && inner == "task_started") || (user && turn.is_some())) { c.turn_seen = true; }
        }
        let end = job.items.iter().filter(|i| i.digest.is_some()).map(|i| i.item.source_end.parse::<u64>().unwrap()).max().unwrap();
        while !c.ready && c.search.boundary == u64::MAX && budget.available() {
            let prior = c.replay.clone();
            let span = match Scanner::new(&mut o.file, end).next(&mut c.replay, budget)? { Next::Record(s) => s, Next::Pending => return Ok(()), Next::End => { c.ready = true; break; } };
            let raw = match read_span(&mut o.file, span, budget) { Ok(v) => v, Err(e) if e == "slicePending" => { c.replay = prior; return Ok(()); }, Err(e) => return Err(e) };
            if let Some(v) = raw.and_then(|r| bounded_value(&r).ok()) {
                check_identity("codex", &self.descriptor.expected_agent_session_id, &v)?;
                let paired = c.context.apply(&v, &project("codex", &v));
                for selected in &mut job.items { if selected.digest.is_some() && selected.item.source_start == span.start.to_string() { selected.suppressed = paired; } }
            } else { c.context.turn = None; for n in c.context.counts.values_mut() { *n = 0; } }
            if c.replay.boundary >= end { c.ready = true; }
        }
        Ok(())
    }
}

impl ArchiveState {
    fn body(&self, owner: &str, id: &str, body_ref: &str, cursor: Option<&str>) -> Result<BodyPage, String> {
        let _admission = Admission::enter(&self.jobs)?;
        let reader = self.lease(owner, id)?; let mut r = reader.try_lock().map_err(|_| "readerBusy".to_string())?; r.used = Instant::now();
        let Token::Body { generation, start, end, slot, raw, hash, part } = r.decode(body_ref)? else { return Err("cursorExpired".into()); };
        let (fence, anchor) = r.opened.as_ref().map(|o| (o.fence, o.anchor.clone())).ok_or("cursorExpired".to_string())?;
        r.validate(&generation, fence, &anchor)?;
        if start >= end || end > fence { return Err("cursorExpired".into()); }
        let verification = cursor.filter(|c| c.starts_with("1."));
        let offset: usize = if let Some(token) = verification {
            let Token::VerifyBody { job } = r.decode(token)? else { return Err("cursorExpired".into()); };
            let check = r.body_check.as_ref().ok_or("cursorExpired".to_string())?;
            if check.id != job || check.reference != body_ref { return Err("cursorExpired".into()); }
            check.offset
        } else { cursor.unwrap_or("0").parse().map_err(|_| "cursorExpired".to_string())? };
        if raw {
            let (body_start, body_end) = part.unwrap_or((start,end));
            if body_start < start || body_end > end || body_start >= body_end { return Err("cursorExpired".into()); }
            let length = usize::try_from(body_end-body_start).map_err(|_| "cursorExpired".to_string())?;
            if offset > length { return Err("cursorExpired".into()); }
            if verification.is_none() && (cursor.is_none() || r.verified_body.as_deref() != Some(body_ref)) {
                r.body_check = Some(BodyCheck { id: Uuid::new_v4().to_string(), reference: body_ref.into(), at: start, offset, hash: Sha256::new() });
                r.verified_body = None;
            }
            if let Some(mut check) = r.body_check.take() {
                if check.reference != body_ref { r.body_check = Some(check); return Err("readerBusy".into()); }
                let mut budget = Budget::new();
                while check.at < end && budget.available() && !r.closed.load(Ordering::SeqCst) {
                    let len = ((end-check.at) as usize).min(BLOCK).min(budget.remaining);
                    let bytes = read_bytes(&mut r.opened.as_mut().unwrap().file, check.at, len)?;
                    check.hash.update(&bytes); check.at += len as u64; budget.remaining -= len;
                }
                if check.at != end {
                    let cursor = r.encode(Token::VerifyBody { job: check.id.clone() }); r.body_check = Some(check);
                    return Ok(BodyPage { text: String::new(), cursor: Some(cursor), source_text: true, validation_pending: true });
                }
                if hex::encode(check.hash.finalize()) != hash {
                    r.opened.as_ref().unwrap().source.invalid.store(true, Ordering::SeqCst); return Err("sourceChanged".into());
                }
                r.verified_body = Some(body_ref.into());
            }
            let o = r.opened.as_mut().unwrap();
            let bytes = read_bytes(&mut o.file, body_start+offset as u64, (length-offset).min(BODY_BYTES-4))?;
            let mut consumed = bytes.len();
            if let Err(e) = std::str::from_utf8(&bytes) { if e.error_len().is_none() { consumed = e.valid_up_to(); } }
            if std::str::from_utf8(&bytes[..consumed]).is_err() { consumed = consumed.min(BODY_BYTES/4); }
            let span = Span { start: body_start+offset as u64, end: body_start+offset as u64+consumed as u64 };
            validate_span(&o.source, span, &sha256_hex(&bytes[..consumed]))?;
            let text = match std::str::from_utf8(&bytes[..consumed]) { Ok(t) => t.to_string(), Err(_) => bytes[..consumed].iter().map(|b| format!("\\x{b:02x}")).collect() };
            let next = offset+consumed;
            return Ok(BodyPage { text, cursor: (next < length).then(|| next.to_string()), source_text: true, validation_pending: false });
        }
        let o = r.opened.as_mut().unwrap();
        if end-start > STRUCTURED_BYTES as u64 { return Err("cursorExpired".into()); }
        let bytes = read_bytes(&mut o.file, start, (end-start) as usize)?;
        if sha256_hex(&bytes) != hash { o.source.invalid.store(true, Ordering::SeqCst); return Err("sourceChanged".into()); }
        let v = bounded_value(&bytes).map_err(|_| "sourceChanged".to_string())?;
        check_identity(&r.descriptor.expected_agent_kind, &r.descriptor.expected_agent_session_id, &v)?;
        let text = project(&r.descriptor.expected_agent_kind, &v).into_iter().find(|d| d.slot == slot).map(|d| d.text).ok_or("cursorExpired".to_string())?;
        if offset > text.len() || !text.is_char_boundary(offset) { return Err("cursorExpired".into()); }
        let chunk = prefix(&text[offset..], BODY_BYTES); let next = offset+chunk.len();
        Ok(BodyPage { text: chunk.into(), cursor: (next < text.len()).then(|| next.to_string()), source_text: false, validation_pending: false })
    }
}

fn prefix(text: &str, bytes: usize) -> &str { let mut end = text.len().min(bytes); while !text.is_char_boundary(end) { end -= 1; } &text[..end] }
fn read_bytes(file: &mut File, start: u64, length: usize) -> Result<Vec<u8>, String> { let mut bytes = vec![0; length]; file.seek(SeekFrom::Start(start)).map_err(io_error)?; file.read_exact(&mut bytes).map_err(io_error)?; Ok(bytes) }
fn fingerprint(file: &mut File, start: u64, end: u64) -> Result<Fingerprint, String> { Ok(Fingerprint { start, end, hash: sha256_hex(&read_bytes(file,start,(end-start) as usize)?) }) }
fn validate_span(source: &Source, span: Span, hash: &str) -> Result<(), String> {
    let mut spans = source.spans.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(i) = spans.iter().position(|p| p.start == span.start && p.end == span.end) { let prior = spans.remove(i).unwrap(); if prior.hash != hash { source.invalid.store(true, Ordering::SeqCst); return Err("sourceChanged".into()); } }
    if spans.len() >= 64 { spans.pop_front(); }
    spans.push_back(Fingerprint { start: span.start, end: span.end, hash: hash.into() }); Ok(())
}
fn remember_turn(source: &Source, start: u64, end: u64, turn: Option<String>) {
    if turn.as_ref().is_some_and(|s| s.len() > 256) { return; }
    let mut hints = source.turns.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(h) = hints.iter_mut().find(|h| h.start == start && h.turn == turn) { h.end = h.end.max(end); return; }
    if hints.len() >= 64 { hints.pop_front(); }
    hints.push_back(TurnHint { start, end, turn });
}
fn find_fence(file: &mut File, length: u64, search: &mut u64, budget: &mut Budget) -> Result<Option<u64>, String> {
    while *search > 0 && budget.available() {
        let len = (*search as usize).min(BLOCK).min(budget.remaining); if len == 0 { break; }
        let start = *search-len as u64; let bytes = read_bytes(file,start,len)?; budget.remaining -= len;
        if let Some(i) = bytes.iter().rposition(|b| *b == b'\n') { return Ok(Some(start+i as u64+1)); }
        *search = start;
    }
    let _ = length;
    Ok((*search == 0).then_some(0))
}
#[cfg(unix)]
fn file_identity(file: &File) -> Result<String, String> { use std::os::unix::fs::MetadataExt; let m = file.metadata().map_err(io_error)?; Ok(format!("{}:{}",m.dev(),m.ino())) }
#[cfg(windows)]
fn file_identity(file: &File) -> Result<String, String> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)] #[derive(Default)] struct FileTime { low: u32, high: u32 }
    #[repr(C)] #[derive(Default)] struct Info { attributes: u32, creation: FileTime, access: FileTime, write: FileTime, volume: u32, size_high: u32, size_low: u32, links: u32, index_high: u32, index_low: u32 }
    #[link(name="kernel32")] extern "system" { fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32; }
    let mut info = Info::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 { return Err("permissionDenied".into()); }
    Ok(format!("{}:{}:{}",info.volume,info.index_high,info.index_low))
}

#[derive(Default,Clone)]
struct JsonPrefix { text:String, escape:bool, unicode:Option<(u32,u8)>, utf8:Vec<u8> }
impl JsonPrefix {
    fn character(&mut self,c:char){if self.text.is_empty() && c.is_whitespace(){return;}if self.text.len()<256{self.text.push(c);}}
    fn feed(&mut self,b:u8){
        if self.text.len()>=256{return;}
        if let Some((mut n,count))=self.unicode.take(){
            let Some(d)=(b as char).to_digit(16) else {self.character('�');return;};n=n*16+d;
            if count==3{self.character(char::from_u32(n).unwrap_or('�'));}else{self.unicode=Some((n,count+1));}return;
        }
        if self.escape{self.escape=false;match b{b'u'=>self.unicode=Some((0,0)),b'n'=>self.character('\n'),b'r'=>self.character('\r'),b't'=>self.character('\t'),b'b'=>self.character('\u{8}'),b'f'=>self.character('\u{c}'),_=>self.character(b as char)}return;}
        if b==b'\\'{self.escape=true;return;}
        if b<128 && self.utf8.is_empty(){self.character(b as char);return;}
        self.utf8.push(b);if let Ok(s)=std::str::from_utf8(&self.utf8){let c=s.chars().next().unwrap();self.utf8.clear();self.character(c);}else if self.utf8.len()>=4{self.utf8.clear();self.character('�');}
    }
}

/// Streaming top-level identity probe for raw fallback records. It admits no
/// foreign identity to a body viewer, even when a line is much larger than RAM.
#[derive(Default)]
struct IdentityProbe {
    depth: usize, keys: Vec<String>, quoted: bool, escaped: bool, token: Vec<u8>, pending: Option<Vec<u8>>, scalar: Vec<u8>,
    offset: u64, meta: bool, message_seen: bool, content_array_depth: Option<usize>, string_prefix: JsonPrefix, user_prefix: JsonPrefix,
    block_start: Option<u64>, block_bytes: Vec<u8>, block_kind: Option<String>, block_prefix: JsonPrefix,
    content_index: u32, parts: Vec<(Span,Draft)>, parts_bytes: usize, more_parts: bool,
    direction: Option<Direction>, after_slot: Option<u32>,
    session: Option<String>, codex_id: Option<String>, outer: Option<String>, sidechain: bool, invalid_identity: bool,
}
impl IdentityProbe {
    fn projection(direction: Direction, after_slot: Option<u32>) -> Self { Self { direction:Some(direction), after_slot, ..Self::default() } }
    // Match project()'s effective message: an explicit message wins, otherwise
    // root content is used. Direct strings, text objects and text-block arrays
    // all collect the same bounded decoded prefix.
    fn content_parent_depth(&self) -> Option<usize> {
        if self.message_seen { (self.keys.first().is_some_and(|k|k=="message") && self.keys.get(1).is_some_and(|k|k=="content")).then_some(2) }
        else { self.keys.first().is_some_and(|k|k=="content").then_some(1) }
    }
    fn finish_block(&mut self) {
        let start=self.block_start.take().unwrap(); let end=self.offset;
        let slot=self.content_index.saturating_add(1);
        if self.block_kind.as_deref()==Some("text") && self.user_prefix.text.is_empty() { self.user_prefix=self.block_prefix.clone(); }
        if !matches!(self.block_kind.as_deref(),Some("tool_result"|"image"|"document")) {self.block_bytes.clear();return;}
        if self.after_slot.is_some_and(|s| if self.direction==Some(Direction::Older){slot>=s}else{slot<=s}) {self.block_bytes.clear();return;}
        let attachment=matches!(self.block_kind.as_deref(),Some("image"|"document"));
        let mut draft = bounded_value(&self.block_bytes).ok().and_then(|block|project("claude",&serde_json::json!({"type":"user","message":{"content":[block]}})).into_iter().next())
            .unwrap_or(Draft {slot,kind:if attachment {"attachment"} else {"toolResult"},text:if attachment {"大きい添付資料（元の記録を表示）"} else {"大きいツール結果（元の記録を表示）"}.into(),timestamp:None,call_id:None,tool:None,target:None,aliases:Vec::new(),user_form:None,legacy_index:None});
        draft.slot=slot;draft.text=prefix(&draft.text,PREVIEW_BYTES).into();
        draft.call_id=draft.call_id.map(|s|prefix(&s,256).into());draft.tool=draft.tool.map(|s|prefix(&s,256).into());draft.target=draft.target.map(|s|prefix(&s,1024).into());draft.aliases.clear();
        let bytes=draft.text.len()+1024;
        if self.direction==Some(Direction::Older) {while self.parts.len()>=200 || self.parts_bytes+bytes>REPLY_BYTES-4096 {let (_,old)=self.parts.remove(0);self.parts_bytes-=old.text.len()+1024;self.more_parts=true;}}
        else if self.parts.len()>=200 || self.parts_bytes+bytes>REPLY_BYTES-4096 {self.more_parts=true;self.block_bytes.clear();return;}
        self.parts_bytes+=bytes;self.parts.push((Span{start,end},draft));self.block_bytes.clear();
    }
    fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            let at=self.offset;self.offset+=1;
            if self.block_start.is_some() && self.block_bytes.len()<STRUCTURED_BYTES {self.block_bytes.push(b);}
            if self.quoted {
                if self.token.len() < 512 { self.token.push(b); }
                if b!=b'"' || self.escaped {self.string_prefix.feed(b);}
                if self.escaped { self.escaped = false; } else if b == b'\\' { self.escaped = true; } else if b == b'"' { self.quoted = false; self.pending = Some(std::mem::take(&mut self.token)); }
                continue;
            }
            if b.is_ascii_whitespace() { continue; }
            if let Some(token) = self.pending.take() {
                if b == b':' {
                    let key = serde_json::from_slice::<String>(&token).unwrap_or_default();
                    if self.depth==1 && key=="message" || key=="content" && (
                        self.depth==1 && !self.message_seen || self.depth==2 && self.keys.first().is_some_and(|k|k=="message")) {
                        // An explicit message overrides earlier root content;
                        // repeated effective content keys use the last value.
                        if key=="message" {self.message_seen=true;}
                        self.user_prefix=JsonPrefix::default();self.parts.clear();self.parts_bytes=0;self.more_parts=false;self.content_index=0;self.content_array_depth=None;
                    }
                    if self.depth > 0 && self.depth <= 64 { while self.keys.len() < self.depth { self.keys.push(String::new()); } self.keys[self.depth-1] = key; }
                    continue;
                }
                self.value(&token);
            }
            if matches!(b,b','|b'}'|b']') && !self.scalar.is_empty() { let scalar = std::mem::take(&mut self.scalar); self.value(&scalar); }
            match b {
                b'"' => { self.quoted = true; self.token = vec![b]; self.string_prefix=JsonPrefix::default(); }
                b'{' | b'[' => { if self.depth == 1 && self.keys.first().is_some_and(|k| matches!(k.as_str(),"sessionId"|"session_id")) { self.invalid_identity = true; }
                    if b==b'[' && self.content_parent_depth()==Some(self.depth) {self.content_array_depth=Some(self.depth+1);self.content_index=0;}
                    if b==b'{' && self.content_array_depth==Some(self.depth) {self.block_start=Some(at);self.block_bytes=vec![b];self.block_kind=None;self.block_prefix=JsonPrefix::default();}
                    self.depth += 1;
                }
                b'}' | b']' => {
                    if b==b'}' && self.content_array_depth==self.depth.checked_sub(1) && self.block_start.is_some() {self.finish_block();}
                    if self.content_array_depth==Some(self.depth) {self.content_array_depth=None;}
                    self.depth = self.depth.saturating_sub(1); self.keys.truncate(self.depth);
                }
                b',' => {if self.content_array_depth==Some(self.depth){self.content_index=self.content_index.saturating_add(1);}}
                b':' => {}
                _ => { if self.scalar.len() < 32 { self.scalar.push(b); } }
            }
        }
    }
    fn value(&mut self, raw: &[u8]) {
        let key = self.keys.get(self.depth.saturating_sub(1)).map(String::as_str).unwrap_or_default();
        let text = serde_json::from_slice::<String>(raw).ok();
        if self.depth == 1 {
            match key {
                "sessionId" | "session_id" => { if text.is_none() { self.invalid_identity = true; } if self.session.is_some() && self.session != text { self.invalid_identity = true; } self.session = text.clone(); }
                "type" => self.outer = text.clone(),
                "isSidechain" => self.sidechain = raw == b"true",
                "isMeta" => self.meta = raw == b"true",
                _ => {}
            }
        } else if self.depth == 2 && self.keys.first().is_some_and(|k| k == "payload") && key == "id" { self.codex_id = text.clone(); }
        if self.content_array_depth==self.depth.checked_sub(1) && self.block_start.is_some() {
            if key=="type" {self.block_kind=text;}
            else if key=="text" && raw.first()==Some(&b'"') {self.block_prefix=self.string_prefix.clone();}
        } else if raw.first()==Some(&b'"') && self.content_parent_depth().is_some_and(|depth|
            self.depth==depth && key=="content" || self.depth==depth+1 && key=="text") {self.user_prefix=self.string_prefix.clone();}
    }
    fn finish(&mut self) { if let Some(token) = self.pending.take() { self.value(&token); } }
    fn check(&self, d: &Descriptor) -> Result<(), String> {
        if self.sidechain && d.expected_agent_kind != "codex" { return Ok(()); }
        let foreign = if d.expected_agent_kind == "codex" { self.outer.as_deref() == Some("session_meta") && self.codex_id.as_deref() != Some(d.expected_agent_session_id.as_str()) }
            else { self.invalid_identity || self.session.as_ref().is_some_and(|id| id != &d.expected_agent_session_id) };
        if foreign { Err("identityMismatch".into()) } else { Ok(()) }
    }
}
fn opposite_position(p: &Position, direction: Direction) -> Position {
    let mut p = p.clone();
    if let Some(slot) = p.slot { p.slot = match direction { Direction::Older => Some(slot+1), Direction::Newer => slot.checked_sub(1) }; }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use serde_json::{Value, json};
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    // Keep the entire registry and admission state local to each test/helper.
    fn descriptor(kind: &str) -> Descriptor { Descriptor { pty_session_id: "synthetic-pty".into(), tab_id: "synthetic-tab".into(), expected_agent_kind: kind.into(), expected_agent_session_id: ID.into() } }
    fn fixture(kind: &str, values: &[Value]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join(if kind == "codex" { format!("rollout-2026-01-01-{ID}.jsonl") } else { format!("{ID}.jsonl") });
        let mut f = File::create(&path).unwrap();
        if kind == "codex" { writeln!(f,"{}",json!({"type":"session_meta","payload":{"id":ID}})).unwrap(); }
        for v in values { writeln!(f,"{v}").unwrap(); }
        (dir,path)
    }
    fn drain(archive: &ArchiveState, owner: &str, mut result: Page) -> Page {
        let mut seen = HashMap::new();
        for _ in 0..5000 {
            for item in &result.items { seen.insert(item.occurrence_id.clone(), item.clone()); }
            let Some(cursor) = result.scan_continuation.clone() else {
                result.items = seen.into_values().collect(); result.items.sort_by_key(|i|(i.source_start.parse::<u64>().unwrap(),i.slot)); return result;
            };
            result = archive.page(owner,PageRequest { reader_id: result.reader_id.clone(), cursor, limit: None }).unwrap();
        }
        panic!("non-monotonic continuation");
    }
    fn traverse(archive: &ArchiveState, owner: &str, mut result: Page, limit: usize) -> Vec<Item> {
        let mut all = Vec::new();
        loop {
            result = drain(archive,owner,result); all.extend(result.items.clone());
            let Some(cursor) = result.older_cursor.clone() else { assert!(result.reached_start); break; };
            result = archive.page(owner,PageRequest { reader_id:result.reader_id.clone(),cursor,limit:Some(limit) }).unwrap();
        }
        all.sort_by_key(|i|(i.source_start.parse::<u64>().unwrap(),i.slot));
        let ids = all.iter().map(|i|i.occurrence_id.clone()).collect::<std::collections::HashSet<_>>(); assert_eq!(ids.len(),all.len()); all
    }
    #[test]
    fn exhaustive_reverse_pages_match_forward_record_oracle_for_both_providers() {
        let archive = ArchiveState::default();
        for kind in ["claude","codex"] { for count in [0,12,200,201,500] {
            let values = (0..count).map(|n| if kind == "codex" { json!({"type":"response_item","id":"repeated-native","payload":{"type":"message","role":if n%2 == 0 {"user"}else{"assistant"},"content":[{"text":format!("row {n} 日本語 🧑")}]}}) }
                else { json!({"type":if n%2==0 {"user"}else{"assistant"},"uuid":"repeated-native","sessionId":ID,"message":{"content":[{"type":"text","text":format!("row {n} 日本語 🧑")}]}}) }).collect::<Vec<_>>();
            let (dir,path) = fixture(kind,&values); let before = std::fs::read(&path).unwrap();
            let owner = format!("oracle-{kind}-{count}"); let result = drain(&archive,&owner,archive.open(&owner,descriptor(kind),dir.path().into()).unwrap());
            let reader_id = result.reader_id.clone(); let generation = result.source_generation.clone();
            let all = traverse(&archive,&owner,result,7);
            let oracle = values.iter().flat_map(|v|project(kind,v).into_iter().map(|d|d.text)).collect::<Vec<_>>();
            assert_eq!(all.iter().map(|i|i.text.clone()).collect::<Vec<_>>(),oracle);
            assert!(all.iter().all(|i|i.occurrence_id.contains(&generation)));
            assert_eq!(std::fs::read(path).unwrap(),before); archive.close(&owner,&reader_id);
        } }
    }
    #[test]
    fn multi_slot_record_cursor_retries_and_forward_reload_have_no_seam_holes() {
        let archive = ArchiveState::default();
        let blocks = (0..501).map(|n|json!({"type":"text","text":format!("block {n}")})).collect::<Vec<_>>();
        let (dir,_) = fixture("claude",&[json!({"type":"assistant","message":{"content":blocks}})]);
        let owner = "slots"; let result = drain(&archive,owner,archive.open(owner,descriptor("claude"),dir.path().into()).unwrap());
        let id = result.reader_id.clone();
        let old_cursor = result.older_cursor.clone().unwrap();
        let older = drain(&archive,owner,archive.page(owner,PageRequest { reader_id:id.clone(),cursor:old_cursor.clone(),limit:Some(5) }).unwrap());
        let retry = drain(&archive,owner,archive.page(owner,PageRequest { reader_id:id.clone(),cursor:old_cursor,limit:Some(5) }).unwrap());
        assert_eq!(older.items.iter().map(|i|&i.occurrence_id).collect::<Vec<_>>(),retry.items.iter().map(|i|&i.occurrence_id).collect::<Vec<_>>());
        let reloaded = drain(&archive,owner,archive.page(owner,PageRequest { reader_id:id.clone(),cursor:older.newer_cursor.unwrap(),limit:Some(100) }).unwrap());
        assert_eq!(reloaded.items[0].slot,result.items[0].slot);
        assert_eq!(traverse(&archive,owner,result,9).len(),501); archive.close(owner,&id);
    }
    #[test]
    fn codex_pairing_crosses_every_page_and_work_preserves_turn() {
        let archive = ArchiveState::default();
        let mut values = vec![json!({"type":"turn_context","payload":{"turn_id":"t"}})];
        for n in 0..120 {
            values.push(json!({"type":"event_msg","payload":{"type":"user_message","message":format!("input {n}")}}));
            values.push(json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":format!("input {n}")}]}}));
            values.push(json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"work"}]}}));
        }
        let (dir,_) = fixture("codex",&values); let owner = "pairs";
        let first = archive.open(owner,descriptor("codex"),dir.path().into()).unwrap(); let id = first.reader_id.clone();
        let all = traverse(&archive,owner,first,1); assert_eq!(all.iter().filter(|i|i.kind=="user").count(),120); assert_eq!(all.len(),240); archive.close(owner,&id);
    }
    #[test]
    fn lf_fence_growth_and_more_than_200_tail_records_are_lossless() {
        let archive = ArchiveState::default();
        let (dir,path) = fixture("claude",&[json!({"type":"user","message":{"content":"first"}})]); let owner = "append";
        let first = drain(&archive,owner,archive.open(owner,descriptor("claude"),dir.path().into()).unwrap()); let id = first.reader_id.clone();
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        write!(f,"{}",json!({"type":"assistant","message":{"content":"partial 🧑"}})).unwrap(); f.flush().unwrap();
        let empty = drain(&archive,owner,archive.refresh(owner,&id,first.newer_cursor.as_deref().unwrap()).unwrap()); assert!(empty.items.is_empty());
        writeln!(f).unwrap(); for n in 0..500 { writeln!(f,"{}",json!({"type":"user","message":{"content":format!("tail {n}")}})).unwrap(); } f.flush().unwrap();
        let mut result = drain(&archive,owner,archive.refresh(owner,&id,empty.newer_cursor.as_deref().unwrap()).unwrap());
        let mut total = result.items.len(); while !result.reached_fence { result = drain(&archive,owner,archive.page(owner,PageRequest { reader_id:id.clone(),cursor:result.newer_cursor.unwrap(),limit:None }).unwrap()); total += result.items.len(); }
        assert_eq!(total,501); archive.close(owner,&id);
    }
    #[test]
    fn body_chunks_decode_escapes_surrogates_and_utf8_without_preview_loss() {
        let archive = ArchiveState::default();
        let text = "🧑日本語\n\"\\".repeat(13000); let (dir,_) = fixture("claude",&[json!({"type":"assistant","message":{"content":[{"type":"text","text":text}]}})]); let owner = "bodies";
        let first = drain(&archive,owner,archive.open(owner,descriptor("claude"),dir.path().into()).unwrap()); let item = &first.items[0]; let body_ref = item.body_ref.as_deref().unwrap();
        let mut cursor = None; let mut actual = String::new(); loop { let p = archive.body(owner,&first.reader_id,body_ref,cursor.as_deref()).unwrap(); assert!(p.text.len()<=BODY_BYTES); actual.push_str(&p.text); cursor=p.cursor; if cursor.is_none() {break;} }
        assert_eq!(actual,text); archive.close(owner,&first.reader_id);
    }
    #[test]
    fn ownership_generation_replacement_and_foreign_id_are_fail_closed() {
        let archive = ArchiveState::default();
        let (dir,path) = fixture("claude",&[json!({"type":"user","sessionId":ID,"message":{"content":"first"}})]); let owner="identity";
        let one = drain(&archive,owner,archive.open(owner,descriptor("claude"),dir.path().into()).unwrap());
        let two = drain(&archive,"identity-other",archive.open("identity-other",descriptor("claude"),dir.path().into()).unwrap());
        assert_eq!(one.source_generation,two.source_generation);
        assert_eq!(archive.page("wrong-window",PageRequest { reader_id:one.reader_id.clone(),cursor:one.newer_cursor.clone().unwrap(),limit:None }).unwrap_err(),"cursorExpired");
        assert_eq!(archive.page(owner,PageRequest { reader_id:one.reader_id.clone(),cursor:two.newer_cursor.clone().unwrap(),limit:None }).unwrap_err(),"cursorExpired");
        let replacement=path.with_extension("replacement"); std::fs::write(&replacement,std::fs::read(&path).unwrap()).unwrap(); std::fs::rename(replacement,path).unwrap();
        assert_eq!(archive.refresh(owner,&one.reader_id,one.newer_cursor.as_deref().unwrap()).unwrap_err(),"sourceChanged"); archive.close(owner,&one.reader_id); archive.close("identity-other",&two.reader_id);
        let (dir,_) = fixture("claude",&[json!({"type":"user","sessionId":"foreign","message":{"content":"secret"}})]);
        assert_eq!(archive.open("foreign",descriptor("claude"),dir.path().into()).unwrap_err(),"identityMismatch");
    }
    #[test]
    fn giant_fallback_checks_identity_before_exposing_any_body() {
        let archive = ArchiveState::default();
        let text="x".repeat(STRUCTURED_BYTES+17); let (dir,_) = fixture("claude",&[json!({"type":"assistant","sessionId":"foreign","message":{"content":text}})]);
        let owner="giant-foreign"; let mut first=archive.open(owner,descriptor("claude"),dir.path().into()).unwrap(); let id=first.reader_id.clone(); let mut rejected=false;
        for _ in 0..100 { assert!(first.items.is_empty()); let cursor=first.scan_continuation.clone().unwrap(); match archive.page(owner,PageRequest { reader_id:id.clone(),cursor,limit:None }) { Ok(p)=>first=p, Err(e)=>{assert_eq!(e,"identityMismatch");rejected=true;break;} } }
        assert!(rejected); archive.close(owner,&id);
        let mut probe=IdentityProbe::default(); for chunk in br#"{"session\u0049d":"foreign","type":"assistant"}"#.chunks(1) { probe.feed(chunk); } probe.finish(); assert!(probe.check(&descriptor("claude")).is_err());
    }
    #[test]
    fn locator_rejects_ambiguous_files_and_unsafe_ids_without_newest_fallback() {
        let archive = ArchiveState::default();
        assert!(!safe_id("claude","../wrong")); assert!(!safe_id("claude","a*")); assert!(!safe_id("codex","not-a-uuid"));
        let (dir,path)=fixture("claude",&[]); std::fs::create_dir(dir.path().join("other")).unwrap(); std::fs::copy(path,dir.path().join("other").join(format!("{ID}.jsonl"))).unwrap();
        assert_eq!(archive.open("ambiguous",descriptor("claude"),dir.path().into()).unwrap_err(),"ambiguousSource");
        let (dir,path)=fixture("codex",&[]); std::fs::write(path,format!("{}\n",json!({"type":"session_meta","payload":{"id":"child","session_id":ID}}))).unwrap();
        assert_eq!(archive.open("codex-foreign",descriptor("codex"),dir.path().into()).unwrap_err(),"identityMismatch");
    }    #[test]
    fn giant_body_verifies_full_record_in_slices_and_refuses_changed_middle() {
        let archive = ArchiveState::default();
        let text = "x日本語🧑".repeat(350000);
        let (dir,path) = fixture("claude",&[json!({"type":"assistant","sessionId":ID,"message":{"content":text}})]);
        let owner="giant-body";
        let first=drain(&archive,owner,archive.open(owner,descriptor("claude"),dir.path().into()).unwrap());
        let item=&first.items[0]; assert_eq!(item.kind,"source");
        let mut cursor=None; let mut pending=0;
        loop {
            let p=archive.body(owner,&first.reader_id,item.body_ref.as_ref().unwrap(),cursor.as_deref()).unwrap();
            assert!(p.text.len()<=BODY_BYTES);
            if !p.validation_pending { assert!(p.text.starts_with('{')); break; }
            assert!(p.text.is_empty()); pending+=1; cursor=p.cursor;
        }
        assert!(pending>0);
        // Grow the file while changing a middle byte: neither head nor old LF
        // fence moves. The body token's full hash must still reject it.
        let mut f=std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.seek(SeekFrom::Start(2*1024*1024)).unwrap(); f.write_all(b"z").unwrap();
        f.seek(SeekFrom::End(0)).unwrap(); writeln!(f,"{{\"type\":\"progress\"}}").unwrap(); f.flush().unwrap();
        let mut cursor=None; let mut rejected=false;
        for _ in 0..100 {
            match archive.body(owner,&first.reader_id,item.body_ref.as_ref().unwrap(),cursor.as_deref()) {
                Ok(p)=>{assert!(p.validation_pending);assert!(p.text.is_empty());cursor=p.cursor;},
                Err(e)=>{assert_eq!(e,"sourceChanged");rejected=true;break;}
            }
        }
        assert!(rejected);archive.close(owner,&first.reader_id);
    }
    #[test]
    fn retry_and_visited_span_rewrites_validate_source_and_window_cleanup_expires() {
        let archive = ArchiveState::default();
        let values=(0..250).map(|n|json!({"type":"user","sessionId":ID,"message":{"content":format!("{n:04}-{}","x".repeat(512))}})).collect::<Vec<_>>();
        let (dir,path)=fixture("claude",&values);let owner="retry-validation";
        let first=drain(&archive,owner,archive.open(owner,descriptor("claude"),dir.path().into()).unwrap());let id=first.reader_id.clone();
        let cursor=first.older_cursor.clone().unwrap();
        let next=drain(&archive,owner,archive.page(owner,PageRequest{reader_id:id.clone(),cursor:cursor.clone(),limit:Some(2)}).unwrap());
        let at=next.items[0].source_start.parse::<u64>().unwrap()+150;
        let mut f=std::fs::OpenOptions::new().write(true).open(path).unwrap(); f.seek(SeekFrom::Start(at)).unwrap();f.write_all(b"z").unwrap();f.flush().unwrap();
        // A same-size rewrite is caught by its modification time, which Windows stamps from a coarse
        // (about 15.6 ms) clock; move it on explicitly so a fast runner cannot stay in the same tick.
        f.set_modified(SystemTime::now()+Duration::from_secs(2)).unwrap(); drop(f);
        assert_eq!(archive.page(owner,PageRequest{reader_id:id.clone(),cursor,limit:Some(2)}).unwrap_err(),"sourceChanged");
        archive.close_window(owner);assert_eq!(archive.heartbeat(owner,&id).err().as_deref(),Some("cursorExpired"));
        let (dir,path)=fixture("claude",&values);let owner="visited-validation";
        let first=drain(&archive,owner,archive.open(owner,descriptor("claude"),dir.path().into()).unwrap());let id=first.reader_id.clone();
        let cursor=first.older_cursor.clone().unwrap(); let before=first.items[0].source_start.parse::<u64>().unwrap();
        let old=drain(&archive,owner,archive.page(owner,PageRequest{reader_id:id.clone(),cursor,limit:Some(2)}).unwrap());
        // Append makes mtime alone insufficient. Rereading a recorded span
        // through an opposite page detects the changed bytes.
        let mut f=std::fs::OpenOptions::new().write(true).open(path).unwrap();f.seek(SeekFrom::Start(before+150)).unwrap();f.write_all(b"z").unwrap();f.seek(SeekFrom::End(0)).unwrap();writeln!(f,"{{\"type\":\"progress\"}}").unwrap();f.flush().unwrap();
        assert_eq!(archive.page(owner,PageRequest{reader_id:id.clone(),cursor:old.newer_cursor.unwrap(),limit:Some(2)}).unwrap_err(),"sourceChanged");archive.close(owner,&id);
    }
    #[test]
    fn long_context_and_null_turn_reset_match_a_forward_pair_oracle() {
        let archive = ArchiveState::default();
        let mut values=vec![json!({"type":"turn_context","payload":{"turn_id":"long"}}),json!({"type":"event_msg","payload":{"type":"user_message","message":"long request"}})];
        for _ in 0..2400 {values.push(json!({"type":"event_msg","payload":{"type":"token_count","padding":"x".repeat(1024)}}));}
        values.push(json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"long request"}]}}));
        values.push(json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"work"}]}}));
        values.push(json!({"type":"turn_context","payload":{}}));
        values.push(json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"another work"}]}}));
        for n in 0..4 { values.push(if n%2==0 {json!({"type":"event_msg","payload":{"type":"user_message","message":"no turn"}})}else{json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"no turn"}]}})});}
        let digests=values.iter().flat_map(|v|project("codex",v)).filter(|d|d.user_form.is_some()).map(|d|sha256_hex(d.text.as_bytes())).collect::<Vec<_>>();
        let mut reference=PairContext::selected(digests.into_iter());let mut oracle=Vec::new();
        for v in &values {let drafts=project("codex",v);let paired=reference.apply(v,&drafts);for d in drafts{if !paired || d.user_form.is_none(){oracle.push(d.text);}}}
        let (dir,path)=fixture("codex",&values);assert!(path.metadata().unwrap().len()>super::super::archive_scan::SCAN_BYTES as u64);
        let owner="long-context";let first=archive.open(owner,descriptor("codex"),dir.path().into()).unwrap();let id=first.reader_id.clone();let all=traverse(&archive,owner,first,1);
        assert_eq!(all.iter().map(|i|i.text.clone()).collect::<Vec<_>>(),oracle);archive.close(owner,&id);
    }
    #[test]
    fn max_structural_slots_and_incomplete_metadata_header_are_bounded() {
        let archive = ArchiveState::default();
        let blocks=(0..4096).map(|n|json!({"type":"text","text":format!("slot {n}")})).collect::<Vec<_>>();
        let (dir,_)=fixture("claude",&[json!({"type":"assistant","message":{"content":blocks}})]);let owner="max-slots";
        let first=archive.open(owner,descriptor("claude"),dir.path().into()).unwrap();let id=first.reader_id.clone();let all=traverse(&archive,owner,first,199);
        assert_eq!(all.len(),4096);assert_eq!(all.last().unwrap().slot,4096);archive.close(owner,&id);
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join(format!("rollout-2026-{ID}.jsonl"));
        let header=format!("{}",json!({"type":"session_meta","payload":{"id":ID}}));std::fs::write(&path,&header).unwrap();let owner="header-fragment";
        let first=archive.open(owner,descriptor("codex"),dir.path().into()).unwrap();assert!(first.items.is_empty());assert!(!first.reached_start);assert!(!first.reached_fence);
        let mut f=std::fs::OpenOptions::new().append(true).open(path).unwrap();writeln!(f).unwrap();f.flush().unwrap();
        let ready=drain(&archive,owner,archive.page(owner,PageRequest{reader_id:first.reader_id.clone(),cursor:first.scan_continuation.unwrap(),limit:None}).unwrap());
        assert!(ready.reached_start&&ready.reached_fence);assert!(ready.items.is_empty());archive.close(owner,&ready.reader_id);
    }
    #[test]
    fn forward_oracle_checks_occurrence_spans_slots_diagnostics_and_previews() {
        let archive = ArchiveState::default();
        for kind in ["claude","codex"] {
            let long="Unicode 日本語 🧑\n".repeat(3000);
            let values=if kind=="claude" {vec![json!({"type":"user","uuid":"repeat","message":{"content":"one"}}),json!({"type":"assistant","uuid":"repeat","message":{"content":[{"type":"thinking"},{"type":"image"},{"type":"text","text":long},{"type":"tool_use","name":"Read","input":{"file_path":"/synthetic"}}]}}),json!({"type":"user","message":{"content":[{"type":"tool_result","content":"separate output"}]}}),json!({"type":"system","subtype":"compact_boundary"}),json!({"type":"future","note":"unknown"})]}
                else {vec![json!({"type":"turn_context","payload":{"turn_id":"t"}}),json!({"type":"response_item","id":"repeat","payload":{"type":"message","role":"user","content":[{"text":"one"}]}}),json!({"type":"event_msg","payload":{"type":"user_message","message":"one"}}),json!({"type":"response_item","id":"repeat","payload":{"type":"function_call_output","output":"separate output"}}),json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":long}]}}),json!({"type":"future","note":"unknown"})]};
            let (dir,path)=fixture(kind,&values);let bytes=std::fs::read(&path).unwrap();let owner=format!("span-oracle-{kind}");
            let first=drain(&archive,&owner,archive.open(&owner,descriptor(kind),dir.path().into()).unwrap());let id=first.reader_id.clone();let generation=first.source_generation.clone();let all=traverse(&archive,&owner,first,1);
            let selected=values.iter().flat_map(|v|project(kind,v)).filter(|d|d.user_form.is_some()).map(|d|sha256_hex(d.text.as_bytes())).collect::<Vec<_>>();let mut context=PairContext::selected(selected.into_iter());
            let mut at=0usize;let mut oracle=Vec::new();
            for line in bytes.split_inclusive(|b|*b==b'\n') {
                let v:Value=serde_json::from_slice(line).unwrap();let drafts=project(kind,&v);let paired=kind=="codex"&&context.apply(&v,&drafts);
                for d in drafts {if paired&&d.user_form.is_some(){continue;}oracle.push((at.to_string(),(at+line.len()).to_string(),d.slot,d.kind.to_string(),d.timestamp,prefix(&d.text,PREVIEW_BYTES).to_string()));}
                at+=line.len();
            }
            let actual=all.iter().map(|i|(i.source_start.clone(),i.source_end.clone(),i.slot,i.kind.clone(),i.timestamp,i.text.clone())).collect::<Vec<_>>();assert_eq!(actual,oracle);
            for i in &all {assert_eq!(i.occurrence_id,format!("{kind}:{ID}:{generation}:{}:{}",i.source_start,i.slot));}
            assert_eq!(std::fs::read(path).unwrap(),bytes);archive.close(&owner,&id);
        }
    }

    #[test]
    fn lease_and_job_admission_and_ttl_are_bounded() {
        let archive = ArchiveState::default();
        let (dir,_) = fixture("claude",&[json!({"type":"user","message":{"content":"small"}})]);
        let mut readers=Vec::new();
        for n in 0..8 { readers.push(archive.open(&format!("admission-{n}"),descriptor("claude"),dir.path().into()).unwrap()); }
        assert_eq!(archive.open("ninth",descriptor("claude"),dir.path().into()).unwrap_err(),"readerBusy");
        assert!(readers.iter().all(|p|p.source_generation==readers[0].source_generation));
        {
            let one=Admission::enter(&archive.jobs).unwrap();let two=Admission::enter(&archive.jobs).unwrap();
            assert_eq!(Admission::enter(&archive.jobs).err().as_deref(),Some("readerBusy"));
            assert_eq!(archive.heartbeat("admission-0",&readers[0].reader_id).err().as_deref(),Some("readerBusy"));
            assert_eq!(archive.jobs.load(Ordering::SeqCst),2);
            drop(two);
            assert!(archive.heartbeat("admission-0",&readers[0].reader_id).is_ok());
            drop(one);
        }
        assert_eq!(archive.jobs.load(Ordering::SeqCst),0);
        let handle=archive.lease("admission-0",&readers[0].reader_id).unwrap();
        {
            let _locked=handle.lock().unwrap();
            assert_eq!(archive.heartbeat("admission-0",&readers[0].reader_id).err().as_deref(),Some("readerBusy"));
            assert_eq!(archive.jobs.load(Ordering::SeqCst),0);
        }
        archive.close("admission-7",&readers[7].reader_id);
        readers[7]=archive.open("admission-7",descriptor("claude"),dir.path().into()).unwrap();
        assert_eq!(archive.open("ninth",descriptor("claude"),dir.path().into()).unwrap_err(),"readerBusy");
        handle.lock().unwrap().used=Instant::now()-TTL;
        assert_eq!(archive.heartbeat("admission-0",&readers[0].reader_id).err().as_deref(),Some("cursorExpired"));
        for (n,p) in readers.iter().enumerate(){archive.close(&format!("admission-{n}"),&p.reader_id);}
    }

    #[test]
    fn independent_states_do_not_share_admission_sources_or_window_cleanup() {
        let first = ArchiveState::default();
        let second = ArchiveState::default();
        let (dir,_) = fixture("claude",&[json!({"type":"user","message":{"content":"same source"}})]);
        let owner="same-window-label";
        let mut readers=Vec::new();
        for _ in 0..8 { readers.push(drain(&first,owner,first.open(owner,descriptor("claude"),dir.path().into()).unwrap())); }
        let one=Admission::enter(&first.jobs).unwrap();let two=Admission::enter(&first.jobs).unwrap();
        assert!(!second.accepted(owner,&descriptor("claude")));
        // The other thread must work even while this state holds all 8 leases
        // and both jobs. No serializing test lock or global-state reset is used.
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let mut other=Vec::new();
                for _ in 0..8 { other.push(drain(&second,owner,second.open(owner,descriptor("claude"),dir.path().into()).unwrap())); }
                assert_eq!(second.open(owner,descriptor("claude"),dir.path().into()).unwrap_err(),"readerBusy");
                assert!(other.iter().all(|p|p.source_generation==other[0].source_generation));
                assert_ne!(other[0].source_generation,readers[0].source_generation);
                assert_eq!(second.heartbeat(owner,&readers[0].reader_id).err().as_deref(),Some("cursorExpired"));
                let one=Admission::enter(&second.jobs).unwrap();let two=Admission::enter(&second.jobs).unwrap();
                assert_eq!(second.heartbeat(owner,&other[0].reader_id).err().as_deref(),Some("readerBusy"));
                drop(two);drop(one);
                second.close_window(owner);
                assert!(!second.accepted(owner,&descriptor("claude")));
                assert_eq!(second.heartbeat(owner,&other[0].reader_id).err().as_deref(),Some("cursorExpired"));
            }).join().unwrap();
        });
        assert_eq!(first.jobs.load(Ordering::SeqCst),2);
        assert!(first.accepted(owner,&descriptor("claude")));
        drop(two);drop(one);
        assert!(first.heartbeat(owner,&readers[0].reader_id).is_ok());
        first.close_window(owner);
        assert!(!first.accepted(owner,&descriptor("claude")));
        assert_eq!(first.heartbeat(owner,&readers[0].reader_id).err().as_deref(),Some("cursorExpired"));
    }

    #[cfg(unix)]
    #[test]
    fn an_opened_path_cannot_be_redirected_to_a_symlink_even_for_the_same_inode() {
        let archive = ArchiveState::default();
        let (dir,path)=fixture("claude",&[json!({"type":"user","message":{"content":"own source"}})]);
        let owner="symlink-race";let first=drain(&archive,owner,archive.open(owner,descriptor("claude"),dir.path().into()).unwrap());
        let outside=tempfile::tempdir().unwrap();let moved=outside.path().join("synthetic.jsonl");std::fs::rename(&path,&moved).unwrap();std::os::unix::fs::symlink(&moved,&path).unwrap();
        assert_eq!(archive.refresh(owner,&first.reader_id,first.newer_cursor.as_deref().unwrap()).unwrap_err(),"sourceChanged");archive.close(owner,&first.reader_id);
    }

    #[test]
    fn review_r7_warm_turn_hints_match_literal_pairs_after_append() {
        let archive=ArchiveState::default();
        let event=|text:&str| json!({"type":"event_msg","payload":{"type":"user_message","message":text}});
        let response=|text:&str| json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}});
        let (dir,path)=fixture("codex",&[json!({"type":"turn_context","payload":{"turn_id":"T"}}),event("A"),response("A")]);
        let first=drain(&archive,"warm",archive.open("warm",descriptor("codex"),dir.path().into()).unwrap());
        assert_eq!(first.items.iter().filter(|i|i.kind=="user").map(|i|i.text.as_str()).collect::<Vec<_>>(),vec!["A"]);
        let mut f=std::fs::OpenOptions::new().append(true).open(path).unwrap();
        for v in [json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"work"}]}}),event("B"),response("B")]{writeln!(f,"{v}").unwrap();}f.flush().unwrap();
        let tail=drain(&archive,"warm",archive.refresh("warm",&first.reader_id,first.newer_cursor.as_deref().unwrap()).unwrap());
        assert_eq!(tail.items.iter().filter(|i|i.kind=="user").map(|i|i.text.as_str()).collect::<Vec<_>>(),vec!["B"]);
        let cold=ArchiveState::default();let cold_page=drain(&cold,"cold",cold.open("cold",descriptor("codex"),dir.path().into()).unwrap());
        assert_eq!(cold_page.items.iter().map(|i|i.text.as_str()).collect::<Vec<_>>(),vec!["A","work","B"]);
        let latest=drain(&archive,"warm",archive.page("warm",PageRequest{reader_id:tail.reader_id.clone(),cursor:tail.latest_cursor.clone().unwrap(),limit:Some(1)}).unwrap());
        let all=traverse(&archive,"warm",latest,1);
        assert_eq!(all.iter().map(|i|i.text.as_str()).collect::<Vec<_>>(),vec!["A","work","B"]);
        let forward_cursor={let lease=archive.lease("warm",&tail.reader_id).unwrap();let r=lease.lock().unwrap();
            let Token::Page{generation,fence,anchor,..}=r.decode(tail.latest_cursor.as_deref().unwrap()).unwrap() else{panic!("page");};
            r.encode(Token::Page{generation,fence,anchor,direction:Direction::Newer,position:Position::at(0)})};
        let mut forward=drain(&archive,"warm",archive.page("warm",PageRequest{reader_id:tail.reader_id.clone(),cursor:forward_cursor,limit:Some(1)}).unwrap());let mut texts=Vec::new();
        loop{texts.extend(forward.items.iter().map(|i|i.text.clone()));if forward.reached_fence{break;}forward=drain(&archive,"warm",archive.page("warm",PageRequest{reader_id:tail.reader_id.clone(),cursor:forward.newer_cursor.unwrap(),limit:Some(1)}).unwrap());}
        assert_eq!(texts,vec!["A","work","B"]);

    }
    #[test]
    fn review_r8_refresh_progresses_past_a_large_unfinished_suffix() {
        let archive=ArchiveState::default();let (dir,path)=fixture("claude",&[json!({"type":"user","message":{"content":"seed"}})]);
        let first=drain(&archive,"tail",archive.open("tail",descriptor("claude"),dir.path().into()).unwrap());
        let mut f=std::fs::OpenOptions::new().append(true).open(path).unwrap();
        for text in ["complete one","complete two"]{writeln!(f,"{}",json!({"type":"user","message":{"content":text}})).unwrap();}
        write!(f,"{{\"type\":\"user\",\"message\":{{\"content\":\"{}", "x".repeat(3*1024*1024)).unwrap();f.flush().unwrap();
        let mut current=first;let mut seen=Vec::new();
        for _ in 0..8{current=drain(&archive,"tail",archive.refresh("tail",&current.reader_id,current.newer_cursor.as_deref().unwrap()).unwrap());seen.extend(current.items.iter().map(|i|i.text.clone()));if seen.len()>=2{break;}}
        assert_eq!(seen,vec!["complete one","complete two"]);
        let latest=drain(&archive,"tail",archive.page("tail",PageRequest{reader_id:current.reader_id.clone(),cursor:current.latest_cursor.clone().unwrap(),limit:None}).unwrap());
        assert_eq!(latest.items.iter().map(|i|i.text.as_str()).collect::<Vec<_>>(),vec!["seed","complete one","complete two"]);
        writeln!(f,"\"}}}}").unwrap();f.flush().unwrap();
        let completed=drain(&archive,"tail",archive.refresh("tail",&current.reader_id,current.newer_cursor.as_deref().unwrap()).unwrap());
        assert_eq!(completed.items.len(),1);assert!(completed.items[0].body_ref.is_some());
    }
    #[test]
    fn review_r10_raw_fallback_filters_meta_and_injection_but_keeps_mixed_results() {
        for big in [false,true]{for meta in [false,true]{for mixed in [false,true]{
            let archive=ArchiveState::default();let text=if meta{"hidden meta ".to_string()}else{"<system-reminder>hidden injection ".to_string()}+&"x".repeat(if big{STRUCTURED_BYTES+1024}else{1024});
            let content=if mixed{json!([{"type":"text","text":text},{"type":"tool_result","tool_use_id":"call","content":"visible result"}])}else{json!(text)};
            let (dir,_)=fixture("claude",&[json!({"type":"user","isMeta":meta,"message":{"content":content}})]);
            let page=drain(&archive,"filter",archive.open("filter",descriptor("claude"),dir.path().into()).unwrap());
            assert_eq!(page.items.len(),usize::from(mixed),"big={big} meta={meta} mixed={mixed}");
            if mixed{assert_eq!(page.items[0].kind,"toolResult");assert_eq!(page.items[0].text,"visible result");assert!(page.items[0].body_ref.is_none());}
        }}}
    }

    #[test]
    fn review_r10_large_mixed_body_exposes_only_the_independent_tool_block() {
        let archive=ArchiveState::default();
        let (dir,_)=fixture("claude",&[json!({"type":"user","isMeta":true,"message":{"content":[
            {"type":"text","text":"SECRET META ".repeat(100000)},
            {"type":"tool_result","tool_use_id":"call","content":"VISIBLE TOOL ".repeat(100000)},
            {"type":"tool_result","tool_use_id":"small","content":"small result"},
            {"type":"image","source":{"type":"base64","data":"ATTACHMENT ".repeat(100000)}}
        ]}})]);
        let page=drain(&archive,"mixed",archive.open("mixed",descriptor("claude"),dir.path().into()).unwrap());
        assert_eq!(page.items.iter().map(|i|i.kind.as_str()).collect::<Vec<_>>(),vec!["toolResult","toolResult","attachment"]);
        assert!(serde_json::to_vec(&page).unwrap().len()<=REPLY_BYTES);
        let mut cursor=None;let mut body=String::new();
        loop{let chunk=archive.body("mixed",&page.reader_id,page.items[0].body_ref.as_deref().unwrap(),cursor.as_deref()).unwrap();assert!(chunk.text.len()<=BODY_BYTES);body.push_str(&chunk.text);cursor=chunk.cursor;if cursor.is_none(){break;}}
        assert!(body.contains("VISIBLE TOOL"));assert!(!body.contains("SECRET META"));assert!(!body.contains("small result"));assert_eq!(page.items[1].text,"small result");
        let mut cursor=None;let mut body=String::new();
        loop{let chunk=archive.body("mixed",&page.reader_id,page.items[2].body_ref.as_deref().unwrap(),cursor.as_deref()).unwrap();assert!(chunk.text.len()<=BODY_BYTES);body.push_str(&chunk.text);cursor=chunk.cursor;if cursor.is_none(){break;}}
        assert!(body.contains("ATTACHMENT"));assert!(!body.contains("SECRET META"));assert!(!body.contains("VISIBLE TOOL"));
    }

    #[test]
    fn review_f1_exceptional_slots_cross_structural_limit_in_both_directions() {
        let archive=ArchiveState::default();
        let blocks=(1..=5000).map(|slot|json!({"type":"tool_result","content":format!("result {slot}")})).collect::<Vec<_>>();
        let (dir,path)=fixture("claude",&[
            json!({"type":"user","message":{"content":"earlier adjacent"}}),
            json!({"type":"user","sessionId":ID,"isMeta":true,"message":{"content":blocks}}),
        ]);
        let before=std::fs::read(&path).unwrap();
        let mut current=drain(&archive,"slots",archive.open("slots",descriptor("claude"),dir.path().into()).unwrap());
        assert_eq!(current.items.iter().map(|i|i.slot).collect::<Vec<_>>(),(4901..=5000).collect::<Vec<_>>());
        let id=current.reader_id.clone();let mut reverse=Vec::new();
        loop {
            assert!(serde_json::to_vec(&current).unwrap().len()<=REPLY_BYTES);
            reverse.extend(current.items.iter().rev().map(|i|i.text.clone()));
            if current.reached_start {break;}
            let cursor=current.older_cursor.clone().unwrap();
            let request=||PageRequest{reader_id:id.clone(),cursor:cursor.clone(),limit:Some(100)};
            let next=drain(&archive,"slots",archive.page("slots",request()).unwrap());
            let retry=drain(&archive,"slots",archive.page("slots",request()).unwrap());
            assert_eq!(serde_json::to_value(&next).unwrap(),serde_json::to_value(&retry).unwrap());current=next;
        }
        let expected=std::iter::once("earlier adjacent".to_string()).chain((1..=5000).map(|n|format!("result {n}"))).collect::<Vec<_>>();
        assert_eq!(reverse,expected.iter().rev().cloned().collect::<Vec<_>>());
        let mut forward=current.items.iter().map(|i|i.text.clone()).collect::<Vec<_>>();
        while !current.reached_fence {
            let cursor=current.newer_cursor.clone().unwrap();
            let request=||PageRequest{reader_id:id.clone(),cursor:cursor.clone(),limit:Some(100)};
            let next=drain(&archive,"slots",archive.page("slots",request()).unwrap());
            let retry=drain(&archive,"slots",archive.page("slots",request()).unwrap());
            assert_eq!(serde_json::to_value(&next).unwrap(),serde_json::to_value(&retry).unwrap());
            forward.extend(next.items.iter().map(|i|i.text.clone()));current=next;
        }
        assert_eq!(forward,expected);assert_eq!(std::fs::read(path).unwrap(),before);
    }
    fn check_injected_text_shape(shape: &str) {
        for big in [false,true] {
            let text=" \n<system-reminder>EXCLUDED SECRET ".to_string()+&"x".repeat(if big{STRUCTURED_BYTES+1024}else{1024});
            let content=if shape.ends_with("object"){json!({"text":text})}
                else if shape.ends_with("array"){json!([
                    {"type":"text","text":text},{"type":"tool_result","content":"independent result"},
                    {"type":"image","source":{"data":"independent attachment"}}
                ])}else{json!(text)};
            let record=if shape.starts_with("root"){json!({"type":"user","sessionId":ID,"content":content})}
                else{json!({"type":"user","sessionId":ID,"message":{"content":content}})};
            let archive=ArchiveState::default();let (dir,_)=fixture("claude",&[record]);
            let page=drain(&archive,"shape",archive.open("shape",descriptor("claude"),dir.path().into()).unwrap());
            let expected=if shape.ends_with("array"){vec!["toolResult","attachment"]}else{vec![]};
            assert_eq!(page.items.iter().map(|i|i.kind.as_str()).collect::<Vec<_>>(),expected,"shape={shape} big={big}");
            assert!(page.items.iter().all(|i|i.body_ref.is_none()),"excluded whole record must have no body reference");
            if shape.ends_with("array"){assert_eq!(page.items[0].text,"independent result");}
        }
        if shape=="root-array" {
            let content=json!([
                {"type":"text","text":"<system-reminder>EXCLUDED SECRET ".to_string()+&"x".repeat(STRUCTURED_BYTES)},
                {"type":"tool_result","content":"VISIBLE ROOT TOOL ".repeat(70000)},
                {"type":"image","source":{"data":"NEIGHBOR ATTACHMENT"}}
            ]);
            let archive=ArchiveState::default();let (dir,_)=fixture("claude",&[json!({"type":"user","content":content})]);
            let page=drain(&archive,"root-body",archive.open("root-body",descriptor("claude"),dir.path().into()).unwrap());
            assert_eq!(page.items.iter().map(|i|i.kind.as_str()).collect::<Vec<_>>(),vec!["toolResult","attachment"]);
            let mut cursor=None;let mut body=String::new();
            loop {let chunk=archive.body("root-body",&page.reader_id,page.items[0].body_ref.as_deref().unwrap(),cursor.as_deref()).unwrap();
                assert!(chunk.text.len()<=BODY_BYTES);body.push_str(&chunk.text);cursor=chunk.cursor;if cursor.is_none(){break;}}
            assert!(body.contains("VISIBLE ROOT TOOL"));assert!(!body.contains("EXCLUDED SECRET"));assert!(!body.contains("NEIGHBOR ATTACHMENT"));
            // Explicit message content overrides root content regardless of JSON
            // key order. Provisional root parts must never survive that choice.
            let root=json!([{"type":"text","text":"<system-reminder>EXCLUDED ROOT"},{"type":"tool_result","content":"IGNORED ROOT RESULT"}]);
            let message=json!({"content":[{"type":"text","text":"<system-reminder>EXCLUDED MESSAGE ".to_string()+&"x".repeat(STRUCTURED_BYTES)},{"type":"tool_result","content":"selected result"}]});
            for raw in [format!("{{\"type\":\"user\",\"content\":{root},\"message\":{message}}}"),format!("{{\"type\":\"user\",\"message\":{message},\"content\":{root}}}")] {
                let archive=ArchiveState::default();let (dir,path)=fixture("claude",&[]);std::fs::write(path,format!("{raw}\n")).unwrap();
                let page=drain(&archive,"effective",archive.open("effective",descriptor("claude"),dir.path().into()).unwrap());
                assert_eq!(page.items.iter().map(|i|i.text.as_str()).collect::<Vec<_>>(),vec!["selected result"]);assert!(page.items[0].body_ref.is_none());
            }
        }
    }
    #[test]
    fn review_f2_nested_object_filters_injection_below_and_above_limit(){check_injected_text_shape("nested-object");}
    #[test]
    fn review_f2_root_string_filters_injection_below_and_above_limit(){check_injected_text_shape("root-string");}
    #[test]
    fn review_f2_root_object_filters_injection_below_and_above_limit(){check_injected_text_shape("root-object");}
    #[test]
    fn review_f2_root_array_filters_injection_and_keeps_independent_blocks(){check_injected_text_shape("root-array");}

}
