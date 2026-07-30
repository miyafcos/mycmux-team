use crate::session_state::{
    AttentionKind, Evidence, EvidenceSignal, EvidenceSource, MonitorStatus, ProcessIdentity,
};
#[cfg(test)]
use chrono::TimeZone;
use chrono::{DateTime, Local, Utc};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const BIND_WINDOW_MS: u64 = 30_000;
const EVENT_START_SKEW_MS: u64 = 5_000;
const INITIAL_TAIL_BYTES: u64 = 1_048_576;
const MAX_PENDING_LINE_BYTES: usize = 1_048_576;
const CODEX_ATTENTION_STALE_AFTER_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct CodexProcessIdentity {
    pub(super) pid: u32,
    pub(super) started_at: u64,
    pub(super) session_epoch: u64,
}

impl CodexProcessIdentity {
    fn process(self) -> ProcessIdentity {
        ProcessIdentity {
            pid: self.pid,
            started_at: self.started_at,
        }
    }
}

#[derive(Debug)]
struct BoundRollout {
    identity: CodexProcessIdentity,
    rollout_id: String,
    path: PathBuf,
    offset: u64,
    skip_initial_partial_line: bool,
    pending_line: Vec<u8>,
    pending_call: Option<PendingCall>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingCall {
    call_id: String,
    attention: AttentionKind,
    detail: String,
    turn_id: Option<String>,
}

#[derive(Debug)]
struct RolloutMeta {
    id: String,
    timestamp_ms: u64,
}

#[derive(Debug)]
enum ParsedRolloutEvent {
    Ignore,
    Working {
        observed_at: u64,
    },
    Waiting {
        observed_at: u64,
        call: PendingCall,
    },
    CallCompleted {
        observed_at: u64,
        call_id: String,
    },
    Done {
        observed_at: u64,
        turn_id: Option<String>,
    },
    Degraded {
        observed_at: u64,
    },
}

pub(super) struct CodexRolloutDetector {
    sessions_root: Option<PathBuf>,
    bindings: HashMap<String, BoundRollout>,
    known_identities: HashMap<String, CodexProcessIdentity>,
    claimed_paths: HashMap<PathBuf, String>,
}

impl CodexRolloutDetector {
    pub(super) fn new() -> Self {
        let codex_root = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex")));
        Self {
            sessions_root: codex_root.map(|root| root.join("sessions")),
            bindings: HashMap::new(),
            known_identities: HashMap::new(),
            claimed_paths: HashMap::new(),
        }
    }

    #[cfg(test)]
    fn with_sessions_root(sessions_root: PathBuf) -> Self {
        Self {
            sessions_root: Some(sessions_root),
            bindings: HashMap::new(),
            known_identities: HashMap::new(),
            claimed_paths: HashMap::new(),
        }
    }

    pub(super) fn poll(
        &mut self,
        session_id: &str,
        identity: CodexProcessIdentity,
        exact_rollout_id: Option<&str>,
    ) -> Vec<Evidence> {
        if self
            .bindings
            .get(session_id)
            .is_some_and(|binding| binding.identity != identity)
        {
            self.drop_binding(session_id);
            return Vec::new();
        }

        if !self.bindings.contains_key(session_id) {
            if self.known_identities.get(session_id).is_some_and(|known| {
                (known.pid == identity.pid
                    && known.started_at == identity.started_at
                    && known.session_epoch != identity.session_epoch)
                    || known.started_at > identity.started_at
            }) {
                return Vec::new();
            }
            let Some(root) = self.sessions_root.as_deref() else {
                return Vec::new();
            };
            let Some((path, meta)) = find_unique_rollout(root, identity, exact_rollout_id) else {
                return Vec::new();
            };
            if self
                .claimed_paths
                .get(&path)
                .is_some_and(|owner| owner != session_id)
            {
                return Vec::new();
            }
            let offset = initial_tail_offset(&path).unwrap_or_default();
            self.claimed_paths
                .insert(path.clone(), session_id.to_string());
            self.bindings.insert(
                session_id.to_string(),
                BoundRollout {
                    identity,
                    rollout_id: meta.id,
                    path,
                    offset,
                    skip_initial_partial_line: offset > 0,
                    pending_line: Vec::new(),
                    pending_call: None,
                },
            );
            self.known_identities
                .insert(session_id.to_string(), identity);
        }

        let Some(binding) = self.bindings.get_mut(session_id) else {
            return Vec::new();
        };
        tail_binding(binding)
    }

    pub(super) fn remove(&mut self, session_id: &str) {
        self.drop_binding(session_id);
    }

    pub(super) fn retain_active(&mut self, active: &HashSet<String>) {
        let removed: Vec<_> = self
            .bindings
            .keys()
            .filter(|session_id| !active.contains(*session_id))
            .cloned()
            .collect();
        for session_id in removed {
            self.drop_binding(&session_id);
        }
        self.known_identities
            .retain(|session_id, _| active.contains(session_id));
    }

    fn drop_binding(&mut self, session_id: &str) {
        if let Some(binding) = self.bindings.remove(session_id) {
            if self
                .claimed_paths
                .get(&binding.path)
                .is_some_and(|owner| owner == session_id)
            {
                self.claimed_paths.remove(&binding.path);
            }
        }
    }
}

fn find_unique_rollout(
    sessions_root: &Path,
    identity: CodexProcessIdentity,
    exact_rollout_id: Option<&str>,
) -> Option<(PathBuf, RolloutMeta)> {
    let search_roots = rollout_search_roots(sessions_root, identity.started_at, exact_rollout_id);
    let mut matches = Vec::new();
    for root in search_roots {
        visit_rollout_files(&root, exact_rollout_id, &mut |path| {
            let Some(meta) = read_rollout_meta(path) else {
                return;
            };
            let matches_identity = match exact_rollout_id {
                Some(exact) => meta.id == exact,
                None => {
                    meta.timestamp_ms.abs_diff(identity.started_at) <= BIND_WINDOW_MS
                        && file_created_near(path, identity.started_at)
                }
            };
            if matches_identity {
                matches.push((path.to_path_buf(), meta));
            }
        });
        if matches.len() > 1 {
            return None;
        }
    }
    if matches.len() == 1 {
        matches.pop()
    } else {
        None
    }
}

fn rollout_search_roots(
    sessions_root: &Path,
    started_at: u64,
    exact_rollout_id: Option<&str>,
) -> Vec<PathBuf> {
    if exact_rollout_id.is_some() {
        return vec![sessions_root.to_path_buf()];
    }
    let Some(started_at) = i64::try_from(started_at)
        .ok()
        .and_then(DateTime::<Utc>::from_timestamp_millis)
    else {
        return vec![sessions_root.to_path_buf()];
    };
    let local = started_at.with_timezone(&Local);
    let mut roots = Vec::new();
    for day_delta in -1..=1 {
        let date = local.date_naive() + chrono::Duration::days(day_delta);
        let candidate = sessions_root
            .join(date.format("%Y").to_string())
            .join(date.format("%m").to_string())
            .join(date.format("%d").to_string());
        if candidate.is_dir() {
            roots.push(candidate);
        }
    }
    if roots.is_empty() {
        roots.push(sessions_root.to_path_buf());
    }
    roots
}

fn visit_rollout_files(dir: &Path, exact_rollout_id: Option<&str>, visit: &mut impl FnMut(&Path)) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit_rollout_files(&path, exact_rollout_id, visit);
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(exact) = exact_rollout_id {
            let matches_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.ends_with(&format!("{exact}.jsonl")));
            if !matches_name {
                continue;
            }
        }
        visit(&path);
    }
}

fn read_rollout_meta(path: &Path) -> Option<RolloutMeta> {
    let file = File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    let value: Value = serde_json::from_str(line.trim_end()).ok()?;
    validate_envelope(&value).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let timestamp_ms = parse_timestamp(value.get("timestamp")?.as_str()?).ok()?;
    let id = value
        .get("payload")?
        .get("id")?
        .as_str()?
        .trim()
        .to_string();
    if id.is_empty() {
        return None;
    }
    Some(RolloutMeta { id, timestamp_ms })
}

fn file_created_near(path: &Path, started_at: u64) -> bool {
    let Ok(created) = path.metadata().and_then(|metadata| metadata.created()) else {
        return false;
    };
    let Ok(created) = created.duration_since(std::time::UNIX_EPOCH) else {
        return false;
    };
    let created_ms = u64::try_from(created.as_millis()).unwrap_or(u64::MAX);
    created_ms.abs_diff(started_at) <= BIND_WINDOW_MS
}

fn initial_tail_offset(path: &Path) -> Option<u64> {
    let len = path.metadata().ok()?.len();
    Some(len.saturating_sub(INITIAL_TAIL_BYTES))
}

fn tail_binding(binding: &mut BoundRollout) -> Vec<Evidence> {
    let Ok(mut file) = File::open(&binding.path) else {
        return vec![degraded_evidence(
            crate::session_state::unix_epoch_millis(),
            binding.identity,
        )];
    };
    let Ok(len) = file.metadata().map(|metadata| metadata.len()) else {
        return vec![degraded_evidence(
            crate::session_state::unix_epoch_millis(),
            binding.identity,
        )];
    };
    if len < binding.offset {
        binding.offset = len;
        binding.pending_line.clear();
        return vec![degraded_evidence(
            crate::session_state::unix_epoch_millis(),
            binding.identity,
        )];
    }
    if file.seek(SeekFrom::Start(binding.offset)).is_err() {
        return vec![degraded_evidence(
            crate::session_state::unix_epoch_millis(),
            binding.identity,
        )];
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return vec![degraded_evidence(
            crate::session_state::unix_epoch_millis(),
            binding.identity,
        )];
    }
    binding.offset = binding
        .offset
        .saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
    if bytes.is_empty() {
        return Vec::new();
    }

    let started_mid_line = binding.skip_initial_partial_line;
    binding.skip_initial_partial_line = false;
    binding.pending_line.extend_from_slice(&bytes);
    let mut complete_end = binding.pending_line.len();
    if !binding.pending_line.ends_with(b"\n") {
        complete_end = binding
            .pending_line
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0);
    }
    if complete_end == 0 {
        if binding.pending_line.len() > MAX_PENDING_LINE_BYTES {
            binding.pending_line.clear();
            return vec![degraded_evidence(
                crate::session_state::unix_epoch_millis(),
                binding.identity,
            )];
        }
        return Vec::new();
    }

    let complete = binding.pending_line[..complete_end].to_vec();
    binding.pending_line.drain(..complete_end);
    let mut evidence = Vec::new();
    for (index, raw_line) in complete.split(|byte| *byte == b'\n').enumerate() {
        let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if raw_line.is_empty() || (started_mid_line && index == 0) {
            continue;
        }
        let event = match std::str::from_utf8(raw_line)
            .ok()
            .and_then(|line| parse_rollout_event(line, binding.identity.started_at).ok())
        {
            Some(event) => event,
            None => ParsedRolloutEvent::Degraded {
                observed_at: crate::session_state::unix_epoch_millis(),
            },
        };
        apply_event(binding, event, &mut evidence);
    }
    evidence
}

fn apply_event(
    binding: &mut BoundRollout,
    event: ParsedRolloutEvent,
    evidence: &mut Vec<Evidence>,
) {
    match event {
        ParsedRolloutEvent::Ignore => {}
        ParsedRolloutEvent::Working { observed_at } => {
            binding.pending_call = None;
            evidence.push(attention_evidence(
                observed_at,
                binding.identity,
                AttentionKind::None,
                None,
                None,
            ));
            evidence.push(status_evidence(
                observed_at,
                binding.identity,
                MonitorStatus::Working,
            ));
        }
        ParsedRolloutEvent::Waiting { observed_at, call } => {
            let attention_id = format!("codex:{}:{}", binding.rollout_id, call.call_id);
            evidence.push(status_evidence(
                observed_at,
                binding.identity,
                MonitorStatus::Idle,
            ));
            evidence.push(attention_evidence(
                observed_at,
                binding.identity,
                call.attention,
                Some(attention_id),
                Some(call.detail.clone()),
            ));
            binding.pending_call = Some(call);
        }
        ParsedRolloutEvent::CallCompleted {
            observed_at,
            call_id,
        } => {
            if binding
                .pending_call
                .as_ref()
                .is_some_and(|pending| pending.call_id == call_id)
            {
                binding.pending_call = None;
                evidence.push(attention_evidence(
                    observed_at,
                    binding.identity,
                    AttentionKind::None,
                    None,
                    None,
                ));
                evidence.push(status_evidence(
                    observed_at,
                    binding.identity,
                    MonitorStatus::Working,
                ));
            }
        }
        ParsedRolloutEvent::Done {
            observed_at,
            turn_id,
        } => {
            if binding.pending_call.as_ref().is_some_and(|pending| {
                pending.turn_id.is_none() || turn_id.is_none() || pending.turn_id == turn_id
            }) {
                return;
            }
            binding.pending_call = None;
            evidence.push(status_evidence(
                observed_at,
                binding.identity,
                MonitorStatus::Idle,
            ));
            let attention_id =
                turn_id.map(|turn_id| format!("codex:{}:{turn_id}:done", binding.rollout_id));
            evidence.push(attention_evidence(
                observed_at,
                binding.identity,
                AttentionKind::Done,
                attention_id,
                None,
            ));
        }
        ParsedRolloutEvent::Degraded { observed_at } => {
            binding.pending_call = None;
            evidence.push(attention_evidence(
                observed_at,
                binding.identity,
                AttentionKind::None,
                None,
                None,
            ));
            evidence.push(degraded_evidence(observed_at, binding.identity));
        }
    }
}

fn parse_rollout_event(line: &str, process_started_at: u64) -> Result<ParsedRolloutEvent, ()> {
    let value: Value = serde_json::from_str(line).map_err(|_| ())?;
    validate_envelope(&value)?;
    let observed_at = parse_timestamp(value.get("timestamp").and_then(Value::as_str).ok_or(())?)?;
    if observed_at.saturating_add(EVENT_START_SKEW_MS) < process_started_at {
        return Ok(ParsedRolloutEvent::Ignore);
    }
    let record_type = value.get("type").and_then(Value::as_str).ok_or(())?;
    let payload = value.get("payload").and_then(Value::as_object).ok_or(())?;
    match record_type {
        "session_meta"
        | "turn_context"
        | "world_state"
        | "compacted"
        | "inter_agent_communication_metadata" => Ok(ParsedRolloutEvent::Ignore),
        "event_msg" => parse_event_message(payload, observed_at),
        "response_item" => parse_response_item(payload, observed_at),
        _ => Err(()),
    }
}

fn validate_envelope(value: &Value) -> Result<(), ()> {
    let object = value.as_object().ok_or(())?;
    if object.len() != 3
        || !object.contains_key("timestamp")
        || !object.contains_key("type")
        || !object.contains_key("payload")
    {
        return Err(());
    }
    Ok(())
}

fn parse_event_message(
    payload: &serde_json::Map<String, Value>,
    observed_at: u64,
) -> Result<ParsedRolloutEvent, ()> {
    let event_type = payload.get("type").and_then(Value::as_str).ok_or(())?;
    match event_type {
        "task_started" => Ok(ParsedRolloutEvent::Working { observed_at }),
        "task_complete" => Ok(ParsedRolloutEvent::Done {
            observed_at,
            turn_id: optional_string(payload, "turn_id"),
        }),
        "turn_aborted" => Ok(ParsedRolloutEvent::Degraded { observed_at }),
        "agent_message"
        | "agent_reasoning"
        | "collab_agent_interaction_end"
        | "collab_agent_spawn_end"
        | "collab_close_end"
        | "collab_waiting_end"
        | "context_compacted"
        | "error"
        | "exec_command_end"
        | "image_generation_end"
        | "item_completed"
        | "mcp_tool_call_end"
        | "patch_apply_end"
        | "sub_agent_activity"
        | "thread_goal_updated"
        | "thread_name_updated"
        | "thread_rolled_back"
        | "thread_settings_applied"
        | "token_count"
        | "user_message"
        | "view_image_tool_call"
        | "web_search_end" => Ok(ParsedRolloutEvent::Ignore),
        _ => Err(()),
    }
}

fn parse_response_item(
    payload: &serde_json::Map<String, Value>,
    observed_at: u64,
) -> Result<ParsedRolloutEvent, ()> {
    let item_type = payload.get("type").and_then(Value::as_str).ok_or(())?;
    match item_type {
        "function_call" => {
            let name = payload.get("name").and_then(Value::as_str).ok_or(())?;
            if name != "request_user_input" && name != "request_permissions" {
                return Ok(ParsedRolloutEvent::Ignore);
            }
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(())?
                .to_string();
            let arguments = payload.get("arguments").and_then(Value::as_str).ok_or(())?;
            let arguments: Value = serde_json::from_str(arguments).map_err(|_| ())?;
            let (attention, detail) = if name == "request_permissions" {
                (
                    AttentionKind::Approval,
                    arguments
                        .get("reason")
                        .and_then(Value::as_str)
                        .map(one_line)
                        .filter(|value| !value.is_empty())
                        .ok_or(())?,
                )
            } else {
                (AttentionKind::Input, first_question(&arguments).ok_or(())?)
            };
            Ok(ParsedRolloutEvent::Waiting {
                observed_at,
                call: PendingCall {
                    call_id,
                    attention,
                    detail,
                    turn_id: optional_string(payload, "turn_id"),
                },
            })
        }
        "function_call_output" => Ok(ParsedRolloutEvent::CallCompleted {
            observed_at,
            call_id: payload
                .get("call_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(())?
                .to_string(),
        }),
        "agent_message"
        | "custom_tool_call"
        | "custom_tool_call_output"
        | "image_generation_call"
        | "message"
        | "reasoning"
        | "tool_search_call"
        | "tool_search_output"
        | "web_search_call" => Ok(ParsedRolloutEvent::Ignore),
        _ => Err(()),
    }
}

fn optional_string(payload: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_question(arguments: &Value) -> Option<String> {
    arguments
        .get("questions")?
        .as_array()?
        .iter()
        .find_map(|question| question.get("question").and_then(Value::as_str))
        .map(one_line)
        .filter(|value| !value.is_empty())
}

fn one_line(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(240).collect()
}

fn parse_timestamp(value: &str) -> Result<u64, ()> {
    let parsed = DateTime::parse_from_rfc3339(value).map_err(|_| ())?;
    u64::try_from(parsed.timestamp_millis()).map_err(|_| ())
}

fn status_evidence(
    observed_at: u64,
    identity: CodexProcessIdentity,
    status: MonitorStatus,
) -> Evidence {
    Evidence {
        observed_at,
        source: EvidenceSource::CodexRollout,
        session_epoch: Some(identity.session_epoch),
        process: Some(identity.process()),
        signal: EvidenceSignal::MonitorStatus { status },
    }
}

fn degraded_evidence(observed_at: u64, identity: CodexProcessIdentity) -> Evidence {
    status_evidence(observed_at, identity, MonitorStatus::Unknown)
}

fn attention_evidence(
    observed_at: u64,
    identity: CodexProcessIdentity,
    attention: AttentionKind,
    attention_id: Option<String>,
    detail: Option<String>,
) -> Evidence {
    Evidence {
        observed_at,
        source: EvidenceSource::CodexRollout,
        session_epoch: Some(identity.session_epoch),
        process: Some(identity.process()),
        signal: EvidenceSignal::Hook {
            attention,
            attention_id,
            detail,
            confidence: 0.95,
            stale_after: CODEX_ATTENTION_STALE_AFTER_MS,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_state::{
        derive_ui_state, reduce, Activity, Health, SessionView, UiSessionState,
    };
    use std::io::Write;

    fn timestamp(ms: u64) -> String {
        Utc.timestamp_millis_opt(i64::try_from(ms).unwrap())
            .single()
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn write_rollout(path: &Path, id: &str, started_at: u64, lines: &[Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = File::create(path).unwrap();
        let meta = serde_json::json!({
            "timestamp": timestamp(started_at),
            "type": "session_meta",
            "payload": { "id": id, "timestamp": timestamp(started_at), "cwd": "C:\\ignored" }
        });
        writeln!(file, "{}", meta).unwrap();
        for line in lines {
            writeln!(file, "{}", line).unwrap();
        }
    }

    fn identity(started_at: u64) -> CodexProcessIdentity {
        CodexProcessIdentity {
            pid: 42,
            started_at,
            session_epoch: 7,
        }
    }

    fn replay(evidence: &[Evidence]) -> SessionView {
        evidence
            .iter()
            .fold(SessionView::new("pty-1"), |view, item| reduce(&view, item))
    }

    #[test]
    fn unique_process_time_candidate_binds_without_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let now = crate::session_state::unix_epoch_millis();
        let path = dir.path().join("2026/07/30/rollout-a.jsonl");
        write_rollout(
            &path,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            now,
            &[serde_json::json!({
                "timestamp": timestamp(now + 1),
                "type": "event_msg",
                "payload": { "type": "task_started", "turn_id": "turn-1" }
            })],
        );
        let mut detector = CodexRolloutDetector::with_sessions_root(dir.path().to_path_buf());
        let evidence = detector.poll("pty-1", identity(now), None);
        let view = replay(&evidence);
        assert_eq!(view.activity, Activity::RunningSilent);
        assert_eq!(view.health, Health::Fresh);
        assert_eq!(view.process.unwrap().pid, 42);
    }

    #[test]
    fn ambiguous_or_wrong_creation_time_does_not_bind() {
        let dir = tempfile::tempdir().unwrap();
        let now = crate::session_state::unix_epoch_millis();
        for suffix in ["a", "b"] {
            write_rollout(
                &dir.path().join(format!("rollout-{suffix}.jsonl")),
                &format!("{suffix}{suffix}{suffix}{suffix}{suffix}{suffix}{suffix}{suffix}-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
                now,
                &[],
            );
        }
        let mut detector = CodexRolloutDetector::with_sessions_root(dir.path().to_path_buf());
        assert!(detector.poll("pty-1", identity(now), None).is_empty());

        let other = tempfile::tempdir().unwrap();
        write_rollout(
            &other.path().join("rollout-old.jsonl"),
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            now.saturating_sub(BIND_WINDOW_MS + 1),
            &[],
        );
        let mut detector = CodexRolloutDetector::with_sessions_root(other.path().to_path_buf());
        assert!(detector.poll("pty-1", identity(now), None).is_empty());
    }

    #[test]
    fn pending_permission_and_completion_become_approval_then_done() {
        let dir = tempfile::tempdir().unwrap();
        let now = crate::session_state::unix_epoch_millis();
        let id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
        let path = dir.path().join(format!("rollout-{id}.jsonl"));
        write_rollout(
            &path,
            id,
            now,
            &[
                serde_json::json!({
                    "timestamp": timestamp(now + 1),
                    "type": "event_msg",
                    "payload": { "type": "task_started", "turn_id": "turn-1" }
                }),
                serde_json::json!({
                    "timestamp": timestamp(now + 2),
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "request_permissions",
                        "call_id": "call-1",
                        "turn_id": "turn-1",
                        "arguments": "{\"permissions\":{\"file_system\":{}},\"reason\":\"Allow the workspace write?\"}"
                    }
                }),
            ],
        );
        let mut detector = CodexRolloutDetector::with_sessions_root(dir.path().to_path_buf());
        let waiting = replay(&detector.poll("pty-1", identity(now), Some(id)));
        assert_eq!(derive_ui_state(&waiting), UiSessionState::Waiting);
        assert_eq!(waiting.attention.kind, AttentionKind::Approval);
        assert_eq!(
            waiting.attention.detail.as_deref(),
            Some("Allow the workspace write?")
        );
        assert_eq!(
            waiting.attention.sources,
            vec![EvidenceSource::CodexRollout]
        );

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "timestamp": timestamp(now + 3),
                "type": "response_item",
                "payload": { "type": "function_call_output", "call_id": "call-1", "output": "{}" }
            })
        )
        .unwrap();
        writeln!(file, "{}", serde_json::json!({
            "timestamp": timestamp(now + 4),
            "type": "event_msg",
            "payload": { "type": "task_complete", "turn_id": "turn-1", "last_agent_message": "Done" }
        })).unwrap();
        let done = detector
            .poll("pty-1", identity(now), Some(id))
            .into_iter()
            .fold(waiting, |view, item| reduce(&view, &item));
        assert_eq!(done.activity, Activity::Idle);
        assert_eq!(done.attention.kind, AttentionKind::Done);
        assert_eq!(derive_ui_state(&done), UiSessionState::Done);
    }

    #[test]
    fn pending_user_input_uses_the_actual_question_line() {
        let dir = tempfile::tempdir().unwrap();
        let now = crate::session_state::unix_epoch_millis();
        let id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
        let path = dir.path().join(format!("rollout-{id}.jsonl"));
        write_rollout(
            &path,
            id,
            now,
            &[serde_json::json!({
                "timestamp": timestamp(now + 1),
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "request_user_input",
                    "call_id": "call-question",
                    "arguments": "{\"questions\":[{\"question\":\"Which target should I use?\",\"options\":[]}]}"
                }
            })],
        );
        let mut detector = CodexRolloutDetector::with_sessions_root(dir.path().to_path_buf());
        let view = replay(&detector.poll("pty-1", identity(now), Some(id)));
        assert_eq!(view.attention.kind, AttentionKind::Input);
        assert_eq!(
            view.attention.detail.as_deref(),
            Some("Which target should I use?")
        );
    }

    #[test]
    fn malformed_or_unknown_format_is_degraded_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let now = crate::session_state::unix_epoch_millis();
        let id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
        let path = dir.path().join(format!("rollout-{id}.jsonl"));
        write_rollout(&path, id, now, &[]);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{{broken-json").unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "timestamp": timestamp(now + 1),
                "type": "unknown_record",
                "payload": {}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "timestamp": timestamp(now + 2),
                "type": "event_msg",
                "payload": { "type": "task_started", "turn_id": "turn-1" },
                "unexpected": true
            })
        )
        .unwrap();
        let mut detector = CodexRolloutDetector::with_sessions_root(dir.path().to_path_buf());
        let view = replay(&detector.poll("pty-1", identity(now), Some(id)));
        assert_eq!(view.activity, Activity::Unknown);
        assert_eq!(view.health, Health::Degraded);
        assert_ne!(derive_ui_state(&view), UiSessionState::Idle);
    }

    #[test]
    fn pid_reuse_or_epoch_change_never_tails_the_old_binding() {
        let dir = tempfile::tempdir().unwrap();
        let now = crate::session_state::unix_epoch_millis();
        let id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
        let path = dir.path().join(format!("rollout-{id}.jsonl"));
        write_rollout(
            &path,
            id,
            now,
            &[serde_json::json!({
                "timestamp": timestamp(now + 1),
                "type": "event_msg",
                "payload": { "type": "task_started", "turn_id": "turn-1" }
            })],
        );
        let mut detector = CodexRolloutDetector::with_sessions_root(dir.path().to_path_buf());
        assert!(!detector.poll("pty-1", identity(now), Some(id)).is_empty());

        let reused_pid = CodexProcessIdentity {
            started_at: now + 60_000,
            ..identity(now)
        };
        assert!(detector.poll("pty-1", reused_pid, Some(id)).is_empty());

        let new_epoch = CodexProcessIdentity {
            session_epoch: 8,
            ..identity(now)
        };
        assert!(detector.poll("pty-1", new_epoch, Some(id)).is_empty());
    }

    #[test]
    fn one_rollout_path_cannot_bind_to_two_pty_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let now = crate::session_state::unix_epoch_millis();
        let id = "11111111-1111-1111-1111-111111111111";
        write_rollout(
            &dir.path().join(format!("rollout-{id}.jsonl")),
            id,
            now,
            &[serde_json::json!({
                "timestamp": timestamp(now + 1),
                "type": "event_msg",
                "payload": { "type": "task_started", "turn_id": "turn-1" }
            })],
        );
        let mut detector = CodexRolloutDetector::with_sessions_root(dir.path().to_path_buf());
        assert!(!detector
            .poll("pty-owner", identity(now), Some(id))
            .is_empty());
        assert!(detector
            .poll("pty-other", identity(now), Some(id))
            .is_empty());
    }
}
