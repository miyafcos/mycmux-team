//! Current, bounded naming evidence with read-only spec references. No model calls.
use super::{chunk, valid_session, TitleRequest, ADAPTERS};
use crate::livebrief::{AgentAdapter, ByteRange, LiveBriefReducer, LiveSessionBrief, SemanticEventEnvelope, SemanticEventKind, UserMessageKind};
use crate::livebrief::naming::NamingPlan;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    path::Path,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tauri::State;

#[derive(Clone, Deserialize)]
pub struct NamingRequest {
    #[serde(flatten)]
    pub title: TitleRequest,
    pub pty_session_id: String,
    #[serde(skip)]
    codex_lookup: Option<super::naming_sources::CodexLookup>,
    #[serde(skip)]
    waiting_for_agent: bool,
}
#[derive(Clone, Serialize)]
pub struct NamingInputSource { pub event_id: String, pub source_revision: u64, pub source_byte_start: u64 }
impl NamingInputSource {
    fn from_event(event: &SemanticEventEnvelope) -> Self {
        Self {event_id:event.event_id.clone(), source_revision:event.source_revision, source_byte_start:event.source_byte_start}
    }
}
#[derive(Default, Serialize)]
pub struct NamingMaterial {
    pub tab_id: String,
    pub pty_session_id: String,
    pub agent_session_id: Option<String>,
    pub agent_kind: String,
    pub cwd: String,
    pub latest_instruction: Option<String>,
    pub latest_instruction_complete: bool,
    pub latest_instruction_kind: Option<UserMessageKind>,
    pub latest_instruction_event_id: Option<String>,
    pub latest_instruction_byte_start: Option<u64>,
    pub instruction_history_complete: bool,
    #[serde(default)]
    pub naming_plan: Option<NamingPlan>,
    pub task_title: Option<String>,
    pub task_title_source: Option<String>,
    pub task_title_explicit: bool,
    pub task_title_input: Option<NamingInputSource>,
    pub initial_instruction_source: Option<NamingInputSource>,
    pub initial_instruction: Option<String>,
    pub initial_instruction_complete: bool,
    pub material_status: Option<String>,
    pub record_owner: Option<String>,
    pub task_title_complete: bool,
    pub events: Vec<SemanticEventEnvelope>,
    pub incomplete_event_ids: Vec<String>,
}
fn bounded(text: &str, limit: usize) -> String { text.chars().take(limit).collect() }
#[derive(Default)]
struct BoundEvents { events: Vec<SemanticEventEnvelope>, incomplete_event_ids: Vec<String>, plan: Option<NamingPlan> }
fn select(mut plan: NamingPlan, events: Vec<SemanticEventEnvelope>) -> BoundEvents {
    let selected = crate::livebrief::naming::project(&plan, events.iter());
    if selected.len() != plan.entries.len() { plan.coverage.source_unknown = true; }
    let incomplete_event_ids = plan.entries.iter().filter(|entry| !entry.complete).map(|entry| entry.event_id.clone()).collect();
    BoundEvents {events: selected, incomplete_event_ids, plan: Some(plan)}
}
fn read_current(path: &Path, kind: &str, deadline: Instant) -> BoundEvents {
    if Instant::now() >= deadline { return BoundEvents::default(); }
    let Ok(mut adapter) = AgentAdapter::new(kind) else { return BoundEvents::default(); };
    let Ok(metadata) = std::fs::metadata(path) else { return BoundEvents::default(); };
    let start = metadata.len().saturating_sub(2 * 1024 * 1024);
    let Some(bytes) = chunk(path, 2 * 1024 * 1024, true) else { return BoundEvents::default(); };
    let mut reducer = LiveBriefReducer::new();
    reducer.naming_source(start, start + bytes.len() as u64, start > 0, false);
    let mut offset = start; let mut events = VecDeque::new();
    for (revision, line) in bytes.split_inclusive(|b| *b == b'\n').enumerate() {
        if Instant::now() >= deadline { reducer.naming_unknown(); break; }
        let range = ByteRange { start: offset, end: offset + line.len() as u64 }; offset = range.end;
        if !line.ends_with(b"\n") || line.len() > 1024 * 1024 { reducer.naming_unknown(); continue; }
        let Ok(raw) = std::str::from_utf8(line) else { reducer.naming_unknown(); continue; };
        if raw.trim().is_empty() { continue; }
        match adapter.decode_record(raw.trim_end(), range, revision as u64) {
            Ok(decoded) => for event in decoded {
                reducer.apply(&event); events.push_back(event);
                // The same selector observes losses before its bounded references leave.
                events.retain(|event| reducer.naming_retains(&event.event_id));
            },
            Err(_) => reducer.naming_unknown(),
        }
    }
    select(reducer.naming_plan(), events.into())
}
fn fallback(request: NamingRequest, deadline: Instant) -> NamingMaterial {
    let mut result = NamingMaterial {
        tab_id: request.title.tab_id.clone(), pty_session_id: request.pty_session_id.clone(),
        agent_session_id: request.title.agent_session_id.clone(), agent_kind: request.title.agent_kind.clone(),
        cwd: request.title.cwd.clone(), ..Default::default()
    };
    if Instant::now() >= deadline { result.material_status = Some("waiting".into()); return result; }
    result.material_status = Some(if request.waiting_for_agent { "waiting" } else { "missing" }.into());
    let path = if request.title.agent_session_id.as_deref().is_some_and(valid_session) {
        ADAPTERS.iter().find(|a| a.kind == request.title.agent_kind)
            .and_then(|adapter| (adapter.locate)(&request.title))
            .map(|path| (path, request.title.agent_session_id.clone().unwrap()))
    } else if request.title.agent_kind == "codex" {
        match request.codex_lookup.as_ref().map(|lookup| super::naming_sources::locate(&request.title, lookup, deadline)) {
            Some(Ok(path)) => path,
            Some(Err(reason)) => { result.material_status = Some(reason.status().into()); None },
            None => { if !request.waiting_for_agent { result.material_status = Some("unverified".into()); } None },
        }
    } else { None };
    if let Some((path, owner)) = path {
        result = material_from_selection(request.clone(), read_current(&path, &request.title.agent_kind, deadline));
        result.record_owner = Some(owner);
        return add_sources(request, result, Some(path), deadline);
    }
    add_sources(request, result, None, deadline)
}
fn read_initial(path: &Path, kind: &str, deadline: Instant) -> Option<(String, NamingInputSource)> {
    let bytes = chunk(path, 4 * 1024 * 1024, false)?;
    let mut adapter = AgentAdapter::new(kind).ok()?;
    let mut offset = 0;
    for (revision, line) in bytes.split_inclusive(|byte| *byte == b'\n').enumerate() {
        if Instant::now() >= deadline || line.len() > 1024 * 1024 { return None; }
        let range = ByteRange {start:offset, end:offset + line.len() as u64}; offset = range.end;
        let raw = std::str::from_utf8(line).ok()?;
        if raw.trim().is_empty() { continue; }
        for event in adapter.decode_record(raw.trim_end(), range, revision as u64).ok()? {
            if let SemanticEventKind::UserMessage {text, ..} = &event.kind {
                if text.starts_with("# AGENTS.md") || text.starts_with('<') { continue; }
                return Some((text.clone(), NamingInputSource::from_event(&event)));
            }
        }
    }
    None
}
fn add_sources(request: NamingRequest, mut result: NamingMaterial, path: Option<std::path::PathBuf>, deadline: Instant) -> NamingMaterial {
    let prompt = path.filter(|_| Instant::now() < deadline).and_then(|path| read_initial(&path, &request.title.agent_kind, deadline));
    if let Some((text, source)) = &prompt {
        result.initial_instruction_complete = text.chars().count() <= 1600;
        result.initial_instruction = Some(bounded(text, 1600));
        result.initial_instruction_source = Some(source.clone());
    }
    if Instant::now() < deadline {
        let latest = result.latest_instruction.as_deref().filter(|_| result.latest_instruction_complete)
            .and_then(|text| super::explicit_task_title(text)).and_then(|title| {
                let mark = result.naming_plan.as_ref()?.latest_input.as_ref()?;
                let entry = result.naming_plan.as_ref()?.entries.iter().find(|entry| entry.event_id == mark.event_id && entry.complete)?;
                Some((title, NamingInputSource {event_id:entry.event_id.clone(), source_revision:entry.source_revision, source_byte_start:entry.source_byte_start}))
            });
        let explicit = latest.or_else(|| prompt.as_ref().and_then(|(text, source)| {
            super::explicit_task_title(text).map(|title| (title, source.clone()))
        }));
        if let Some((text, source)) = explicit {
            result.task_title_complete = text.chars().count() <= 160;
            result.task_title = Some(bounded(&text, 160));
            result.task_title_source = Some("spec".into());
            result.task_title_explicit = true;
            result.task_title_input = Some(source);
        }
    }
    result
}
fn enrich_live((request, material): (NamingRequest, NamingMaterial), deadline: Instant) -> NamingMaterial {
    let path = ADAPTERS.iter().find(|a| a.kind == request.title.agent_kind).and_then(|adapter| (adapter.locate)(&request.title));
    add_sources(request, material, path, deadline)
}
fn material_from_selection(request: NamingRequest, mut selected: BoundEvents) -> NamingMaterial {
    let mark = selected.plan.as_ref().and_then(|plan| plan.latest_input.as_ref());
    let latest = mark.and_then(|mark| selected.events.iter().position(|event| event.event_id == mark.event_id))
        .map(|index| selected.events.remove(index));
    let latest_instruction = latest.and_then(|event| match event.kind {SemanticEventKind::UserMessage {text, ..} => Some(text), _ => None});
    let record_owner = request.title.agent_session_id.clone();
    let material_status = Some(if selected.plan.is_some() { "ready" } else { "unreadable" }.into());
    NamingMaterial {
        tab_id: request.title.tab_id, pty_session_id: request.pty_session_id,
        agent_session_id: request.title.agent_session_id, agent_kind: request.title.agent_kind, cwd: request.title.cwd,
        latest_instruction_complete: mark.is_some_and(|mark| mark.complete && (mark.kind == UserMessageKind::Ack || latest_instruction.is_some())),
        latest_instruction_kind: mark.map(|mark| mark.kind), latest_instruction_event_id: mark.map(|mark| mark.event_id.clone()),
        latest_instruction_byte_start: mark.map(|mark| mark.source_byte_start), latest_instruction,
        instruction_history_complete: selected.plan.as_ref().is_some_and(NamingPlan::history_complete),
        naming_plan: selected.plan, events: selected.events, incomplete_event_ids: selected.incomplete_event_ids,
        task_title: None, task_title_source: None, task_title_complete: true,
        task_title_explicit: false, task_title_input: None, initial_instruction_source: None,
        initial_instruction: None, initial_instruction_complete: false,
        material_status, record_owner,
    }
}
fn material_from_brief(request: NamingRequest, brief: LiveSessionBrief, events: Vec<SemanticEventEnvelope>) -> NamingMaterial {
    let selected = brief.naming_plan.map(|plan| select(plan, events)).unwrap_or_default();
    material_from_selection(request, selected)
}
async fn fallback_batch(requests: Vec<NamingRequest>, limit: Arc<tokio::sync::Semaphore>, deadline: Instant) -> Vec<NamingMaterial> {
    super::material_batch::read_batch(requests, limit, deadline, fallback).await
}
fn observe_request(request: &mut NamingRequest, state: &crate::AppState) {
        request.waiting_for_agent = state.session_manager.session_age(&request.pty_session_id)
            .is_some_and(|age| age < Duration::from_secs(10));
        if request.title.agent_kind == "codex" && request.title.agent_session_id.is_none() {
            if let Some(metadata) = state.metadata_store.get(&request.pty_session_id).map(|row| row.clone()) {
                let current_epoch = state.session_manager.session_observation(&request.pty_session_id).map(|(epoch, _)| epoch);
                if current_epoch == Some(metadata.session_epoch) && metadata.live_agent_kind.as_deref() == Some("codex")
                    && crate::pty::path_norm::normalize_cwd_key(&metadata.cwd) == crate::pty::path_norm::normalize_cwd_key(&request.title.cwd) {
                    // A PTY epoch can contain several successive agent processes.
                    // Trusted identity uses seconds; monitor metadata uses milliseconds.
                    let trusted = state.session_manager.trusted_agent_identity(&request.pty_session_id).filter(|owner|
                        owner.kind == "codex" && owner.session_epoch == metadata.session_epoch
                            && owner.agent_pid > 0 && Some(owner.agent_pid) == metadata.agent_pid
                            && owner.agent_started_at > 0 && metadata.agent_started_at.is_some()
                            && owner.agent_started_at.checked_mul(1_000) == metadata.agent_started_at);
                    if let Some(started_at) = metadata.agent_started_at {
                        let peers: Vec<_> = state.metadata_store.iter().filter(|peer| peer.session_id != request.pty_session_id
                            && peer.live_agent_kind.as_deref() == Some("codex")
                            && crate::pty::path_norm::normalize_cwd_key(&peer.cwd) == crate::pty::path_norm::normalize_cwd_key(&request.title.cwd))
                            .map(|peer| (peer.agent_session_id.clone(), peer.agent_started_at)).collect();
                        let excluded_ids = peers.iter().filter_map(|(id, _)| id.clone()).collect();
                        let contended = peers.iter().any(|(id, birth)| id.is_none() && birth.is_some_and(|birth| birth.abs_diff(started_at) <= 60_000));
                        request.codex_lookup = Some(super::naming_sources::CodexLookup {
                            session_id: trusted.map(|owner| owner.session_id), started_at, excluded_ids, contended,
                        });
                    }
                }
            }
        }
}
#[tauri::command]
pub async fn auto_name_materials(requests: Vec<NamingRequest>, state: State<'_, crate::AppState>) -> Result<Vec<NamingMaterial>, String> {
    if requests.len() > 64 { return Err("At most 64 naming requests are allowed".into()); }
    static LIMIT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let limit = LIMIT.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)));
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut fallback_requests = Vec::new();
    let mut enrich_requests = Vec::new();
    let mut result = Vec::new();
    let requested_count = requests.len();
    for mut request in requests {
        if Instant::now() >= deadline { break; }
        observe_request(&mut request, &state);
        if let Some((brief, events)) = state.livebrief_service.peek_naming_events(&request.pty_session_id) {
            let age = crate::livebrief::unix_ms().saturating_sub(brief.updated_at);
            if brief.telemetry_health == "live" && (0..60_000).contains(&age)
                && Some(brief.binding.agent_session_id.as_str()) == request.title.agent_session_id.as_deref()
                && brief.binding.agent_kind == request.title.agent_kind {
                let material = material_from_brief(request.clone(), brief, events);
                if request.title.agent_kind == "codex" { enrich_requests.push((request, material)); }
                else { result.push(material); }
                continue;
            }
        }
        fallback_requests.push(request);
    }
    result.extend(super::material_batch::read_batch(enrich_requests, limit.clone(), deadline, enrich_live).await);
    result.extend(fallback_batch(fallback_requests, limit.clone(), deadline).await);
    let omitted = requested_count.saturating_sub(result.len());
    if omitted > 0 { crate::diag_warn!("auto-name", "material_read_deadline omitted={omitted} requested={requested_count}"); }
    for material in &result {
        // Keep the diagnostic even when the frontend can use a readable launch label.
        if valid_session(&material.tab_id) && matches!(material.material_status.as_deref(), Some("unverified" | "contended" | "incomplete")) {
            crate::diag_warn!("auto-name", "material_lookup tab={} reason={}", material.tab_id, material.material_status.as_deref().unwrap());
        }
        if matches!(material.material_status.as_deref(), Some("unreadable")) {
            crate::diag_warn!("auto-name", "material_read_failed tab={}", material.tab_id);
        }
    }
    Ok(result)
}

#[cfg(test)]
#[path = "material_conservative_tests.rs"]
mod conservative_tests;

#[cfg(test)]
mod tests {
    use super::*;
    fn event(kind: SemanticEventKind) -> SemanticEventEnvelope {
        SemanticEventEnvelope { event_id: "e".into(), source_revision: 1, occurred_at: 1, source_byte_start: 0, source_byte_end: 1, kind }
    }
    fn request() -> NamingRequest {
        NamingRequest { codex_lookup: None, waiting_for_agent: false, pty_session_id: "pty".into(), title: TitleRequest { tab_id: "tab".into(), agent_kind: "unsupported".into(), agent_session_id: None, cwd: "".into() } }
    }
    #[test]
    fn current_correction_is_decoded_without_old_titles() {
        let path = std::env::temp_dir().join(format!("naming-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&path, concat!(
            "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"動画を編集してください\"}}\n",
            "{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"role\":\"user\",\"content\":\"動画ではなく解説スライドを作ってください\"}}\n"
        )).unwrap();
        let events = read_current(&path, "claude", Instant::now() + Duration::from_secs(5)).events;
        std::fs::remove_file(path).unwrap();
        assert!(events.iter().any(|e| matches!(&e.kind, SemanticEventKind::UserMessage {text,..} if text.contains("解説スライド"))));
    }
    #[test]
    fn bounds_text_and_keeps_only_file_tools_and_basename() {
        let mut events = (0..10).map(|_| event(SemanticEventKind::AgentMessage { text: "語".repeat(1000) })).collect::<Vec<_>>();
        events.push(event(SemanticEventKind::ToolStart { call_id: "shell".into(), tool: "Bash".into(), target: Some("echo secret.mp4".into()) }));
        events.push(event(SemanticEventKind::ToolStart { call_id: "write".into(), tool: "Write".into(), target: Some("C:\\very\\long\\folder\\lesson.pptx".into()) }));
        let mut state = crate::livebrief::naming::NamingState::default();
        for (i, event) in events.iter_mut().enumerate() { event.event_id = format!("e-{i}"); state.observe(event, false); }
        let bounded = select(state.plan(), events).events;
        assert_eq!(bounded.iter().filter(|e| matches!(e.kind, SemanticEventKind::AgentMessage {..})).count(), 2);
        assert!(!bounded.iter().any(|e| matches!(&e.kind, SemanticEventKind::ToolStart {tool,..} if tool == "Bash")));
        assert!(bounded.iter().any(|e| matches!(&e.kind, SemanticEventKind::ToolStart {target: Some(target),..} if target == "lesson.pptx")));
    }
    #[tokio::test]
    async fn deadline_includes_waiting_for_a_reader_slot() {
        let deadline = Instant::now() + Duration::from_millis(20);
        assert!(fallback_batch(vec![request()], Arc::new(tokio::sync::Semaphore::new(0)), deadline).await.is_empty());
    }
    #[tokio::test]
    async fn expired_requests_do_not_start_readers() {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
        assert!(fallback_batch(vec![request()], semaphore.clone(), Instant::now()).await.is_empty());
        assert_eq!(semaphore.available_permits(), 4);
    }

    #[test]
    fn review_native_fixture_matches_real_adapter_output() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/auto_naming_review_native.json")).unwrap();
        fn projection(kind: &serde_json::Value) -> serde_json::Value {
            match kind["type"].as_str().unwrap() {
                "userMessage" => serde_json::json!({"type": "userMessage", "kind": kind["kind"], "text": kind["text"]}),
                "agentMessage" => serde_json::json!({"type": "agentMessage", "text": kind["text"]}),
                "toolStart" => serde_json::json!({"type": "toolStart", "tool": kind["tool"], "target": kind["target"]}),
                _ => unreachable!(),
            }
        }
        let mut mismatches = Vec::new();
        let mut checked_frames = 0;
        for case in fixtures["cases"].as_array().unwrap() {
            for job in case["jobs"].as_array().unwrap() {
                for frame in job["frames"].as_array().unwrap() {
                    let mut adapter = AgentAdapter::new("claude").unwrap();
                    let mut actual = Vec::new();
                    let mut offset = 0;
                    for (revision, record) in frame["raw_records"].as_array().unwrap().iter().enumerate() {
                        let raw = serde_json::to_string(record).unwrap();
                        let range = ByteRange { start: offset, end: offset + raw.len() as u64 };
                        offset = range.end;
                        for event in adapter.decode_record(&raw, range, revision as u64).unwrap() {
                            if matches!(&event.kind, SemanticEventKind::UserMessage {..} | SemanticEventKind::AgentMessage {..} | SemanticEventKind::ToolStart {..}) {
                                actual.push(projection(&serde_json::to_value(event.kind).unwrap()));
                            }
                        }
                    }
                    let expected: Vec<_> = frame["events"].as_array().unwrap().iter().map(|event| projection(&event["kind"])).collect();
                    checked_frames += 1;
                    if actual != expected {
                        mismatches.push(format!(
                            "native fixture {} / {} at {}: actual={actual:?}, expected={expected:?}",
                            case["id"], job["id"], frame["at"],
                        ));
                    }
                }
            }
        }
        assert!(mismatches.is_empty(), "checked {checked_frames} frames; {}", mismatches.join("\n"));
    }
}

#[derive(Deserialize)]
pub struct NamingDiagnostic {
    tab_id: String,
    reason: String,
    retained: bool,
    observations: u32,
    #[serde(default)]
    read_failures: u32,
}
fn valid_diagnostic(row: &NamingDiagnostic) -> bool {
    valid_session(&row.tab_id) && row.observations > 0 && row.observations <= 100_000 && row.read_failures <= 100_000
        && matches!(row.reason.as_str(), "no-record" | "instruction-unclear" | "reply" | "history-incomplete"
            | "instruction-truncated" | "unsafe-name" | "name-too-long" | "name-conflict"
            | "waiting" | "read-failed" | "launch-label-unusable" | "record-unverified" | "record-contended")
}
#[tauri::command]
pub async fn auto_name_diagnostics(requests: Vec<NamingDiagnostic>) -> Result<(), String> {
    if requests.len() > 64 || requests.iter().any(|row| !valid_diagnostic(row)) { return Err("Invalid naming diagnostics".into()); }
    for row in requests {
        crate::diag_warn!("auto-name", "tab={} reason={} retained={} observations={} read_failures={}", row.tab_id, row.reason, row.retained, row.observations, row.read_failures);
    }
    Ok(())
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[test]
    fn diagnostics_accept_codes_and_reject_text_injection() {
        let mut row = NamingDiagnostic { tab_id: "t".into(), reason: "reply".into(), retained: true, observations: 1, read_failures: 0 };
        assert!(valid_diagnostic(&row));
        row.reason = "private conversation text".into();
        assert!(!valid_diagnostic(&row));
        row.reason = "read-failed".into(); row.tab_id = "t\nsecret".into();
        assert!(!valid_diagnostic(&row));
    }
}

#[cfg(test)]
mod source_tests {
    use super::*;
    #[test]
    fn codex_prompt_reads_a_named_spec_without_changing_the_original_binding() {
        let dir = tempfile::tempdir().unwrap();
        let spec = dir.path().join("spec.md");
        std::fs::write(&spec, "# タブ切り離しの修正\n").unwrap();
        let path = dir.path().join("rollout-test.jsonl");
        let record = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":format!("Read \"{}\"", spec.display())}});
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        let request = NamingRequest { title: TitleRequest { tab_id:"t".into(), agent_kind:"codex".into(), agent_session_id:None, cwd:dir.path().to_string_lossy().into() },
            pty_session_id:"pty".into(), codex_lookup:None, waiting_for_agent:false };
        let material = add_sources(request, NamingMaterial::default(), Some(path), Instant::now() + Duration::from_secs(5));
        assert_eq!(material.task_title.as_deref(), Some("タブ切り離しの修正"));
        assert_eq!(material.task_title_source.as_deref(), Some("spec"));
        assert!(material.initial_instruction_complete);
        assert!(material.task_title_explicit);
        assert!(material.task_title_input.is_some());
        assert!(material.initial_instruction_source.is_some());
        assert!(material.agent_session_id.is_none());
    }
}

#[cfg(test)]
mod snapshot_export {
    use super::*;
    /// Explicitly invoked by the handoff's read-only naming comparison. Never runs in the default suite.
    #[test]
    #[ignore]
    fn export_read_only_snapshot() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".mycmux/fix0882/evidence");
        let requests: Vec<NamingRequest> = serde_json::from_slice(&std::fs::read(root.join("naming-requests.json")).unwrap()).unwrap();
        let mut rows = Vec::new();
        for request in requests {
            let titles = super::super::resolve(request.title.clone());
            let material = fallback(request, Instant::now() + Duration::from_secs(5));
            rows.push(serde_json::json!({"titles": titles, "material": material}));
        }
        std::fs::write(root.join("naming-materials.json"), serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
        println!("Read-only snapshot exported: {} tabs", rows.len());
    }
}

#[cfg(test)]
#[path = "material_fix2_tests.rs"]
mod fix2_tests;
