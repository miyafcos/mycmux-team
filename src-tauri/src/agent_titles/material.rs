//! Current, bounded naming evidence. No arbitrary prompt paths or model calls.
use super::{chunk, heading, valid_session, TitleRequest, ADAPTERS};
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
    if Instant::now() >= deadline { return result; }
    if request.title.agent_session_id.as_deref().is_some_and(valid_session) {
        if let Some(adapter) = ADAPTERS.iter().find(|a| a.kind == request.title.agent_kind) {
            if let Some(path) = (adapter.locate)(&request.title) {
                result = material_from_selection(request.clone(), read_current(&path, adapter.kind, deadline));
            }
        }
    }
    // Conventional project-local headings only. Never follow a path quoted in chat.
    if Instant::now() < deadline && !request.title.cwd.trim().is_empty() {
        if let Ok(root) = Path::new(&request.title.cwd).canonicalize() {
            for local in [".dispatch/SPEC.md", "spec.md"] {
                if Instant::now() >= deadline { break; }
                let Ok(path) = root.join(local).canonicalize() else { continue; };
                if !path.starts_with(&root) { continue; }
                if let Some(text) = heading(&path) {
                    result.task_title_complete = text.chars().count() <= 160;
                    result.task_title = Some(bounded(&text, 160));
                    break;
                }
            }
        }
    }
    result
}
fn material_from_selection(request: NamingRequest, mut selected: BoundEvents) -> NamingMaterial {
    let mark = selected.plan.as_ref().and_then(|plan| plan.latest_input.as_ref());
    let latest = mark.and_then(|mark| selected.events.iter().position(|event| event.event_id == mark.event_id))
        .map(|index| selected.events.remove(index));
    let latest_instruction = latest.and_then(|event| match event.kind {SemanticEventKind::UserMessage {text, ..} => Some(text), _ => None});
    NamingMaterial {
        tab_id: request.title.tab_id, pty_session_id: request.pty_session_id,
        agent_session_id: request.title.agent_session_id, agent_kind: request.title.agent_kind, cwd: request.title.cwd,
        latest_instruction_complete: mark.is_some_and(|mark| mark.complete && (mark.kind == UserMessageKind::Ack || latest_instruction.is_some())),
        latest_instruction_kind: mark.map(|mark| mark.kind), latest_instruction_event_id: mark.map(|mark| mark.event_id.clone()),
        latest_instruction_byte_start: mark.map(|mark| mark.source_byte_start), latest_instruction,
        instruction_history_complete: selected.plan.as_ref().is_some_and(NamingPlan::history_complete),
        naming_plan: selected.plan, events: selected.events, incomplete_event_ids: selected.incomplete_event_ids,
        task_title: None, task_title_complete: true,
    }
}
fn material_from_brief(request: NamingRequest, brief: LiveSessionBrief, events: Vec<SemanticEventEnvelope>) -> NamingMaterial {
    let selected = brief.naming_plan.map(|plan| select(plan, events)).unwrap_or_default();
    material_from_selection(request, selected)
}
async fn fallback_batch(requests: Vec<NamingRequest>, limit: Arc<tokio::sync::Semaphore>, deadline: Instant) -> Vec<NamingMaterial> {
    super::material_batch::read_batch(requests, limit, deadline, fallback).await
}
#[tauri::command]
pub async fn auto_name_materials(requests: Vec<NamingRequest>, state: State<'_, crate::AppState>) -> Result<Vec<NamingMaterial>, String> {
    if requests.len() > 64 { return Err("At most 64 naming requests are allowed".into()); }
    static LIMIT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let limit = LIMIT.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)));
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut fallback_requests = Vec::new();
    let mut result = Vec::new();
    for request in requests {
        if Instant::now() >= deadline { break; }
        if let Some((brief, events)) = state.livebrief_service.peek_naming_events(&request.pty_session_id) {
            let age = crate::livebrief::unix_ms().saturating_sub(brief.updated_at);
            if brief.telemetry_health == "live" && (0..60_000).contains(&age)
                && Some(brief.binding.agent_session_id.as_str()) == request.title.agent_session_id.as_deref()
                && brief.binding.agent_kind == request.title.agent_kind {
                result.push(material_from_brief(request, brief, events));
                continue;
            }
        }
        fallback_requests.push(request);
    }
    result.extend(fallback_batch(fallback_requests, limit.clone(), deadline).await);
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
        NamingRequest { pty_session_id: "pty".into(), title: TitleRequest { tab_id: "tab".into(), agent_kind: "unsupported".into(), agent_session_id: None, cwd: "".into() } }
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
