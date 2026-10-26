//! Ordinary messages use the intervention input lock, never answer a prompt,
//! and require a new target-bound user event for acceptance confirmation.
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{adapter::SemanticEventKind, *};
use crate::session_state::{AttentionKind, SessionView};

const MAX_SEND_TAIL_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSourceFence {
    binding: LiveBinding,
    service_epoch: String,
    path_hash: String,
    stream_generation: u64,
    read_offset: u64,
    file_identity: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSendGuard {
    session_id: String,
    session_epoch: u64,
    session_revision: u64,
    strict_revision: bool,
    attention_id: Option<String>,
    input_revision: u64,
    agent_kind: Option<String>,
    agent_session_id: Option<String>,
    agent_pid: Option<u32>,
    agent_started_at: Option<u64>,
    agent_message: bool,
    source: Option<MessageSourceFence>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePreparation { guard: Option<MessageSendGuard>, reason: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWriteResult { sent: bool, reason: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageVerification { confirmed: bool, matched_event_id: Option<String> }

fn has_pending_prompt(snapshot: &SessionSnapshot) -> bool {
    snapshot.brief.operational_state == "needsHuman"
        || (snapshot.brief.prompt_event_id.is_some() && snapshot.brief.pending_input_kind.is_some())
}

fn view_conflict(view: &SessionView, guard: Option<&MessageSendGuard>) -> Option<&'static str> {
    if matches!(view.attention.kind, AttentionKind::Input | AttentionKind::Approval) { return Some("pending_prompt"); }
    let Some(guard) = guard else { return None; };
    if view.session_epoch != Some(guard.session_epoch) { return Some("session_epoch"); }
    if view.attention.attention_id != guard.attention_id { return Some("attention_id"); }
    if guard.strict_revision && view.session_revision != guard.session_revision { return Some("session_revision"); }
    None
}

/// Use only the target's cached cursor. No discovery, bootstrap, history DB,
/// all-session refresh, or unbounded transcript read is allowed for a send.
fn observe(service: &LiveBriefService, id: &str) -> Result<Option<SessionSnapshot>, String> {
    let prior = service.state.lock().map_err(|_| "message observation unavailable")?.sessions.get(id).cloned();
    let Some(mut snapshot) = prior else { return Ok(None); };
    if snapshot.brief.telemetry_health != "live" { return Ok(Some(snapshot)); }
    let metadata = std::fs::metadata(&snapshot.cursor.path).map_err(|_| "message observation unavailable")?;
    if metadata.len() < snapshot.cursor.read_offset
        || metadata.len().saturating_sub(snapshot.cursor.read_offset) > MAX_SEND_TAIL_BYTES
        || transcript_anchor(&snapshot.cursor.path, snapshot.cursor.committed_offset)? != snapshot.cursor.committed_anchor {
        return Err("message observation unavailable".into());
    }
    let mut file = File::open(&snapshot.cursor.path).map_err(|_| "message observation unavailable")?;
    file.seek(SeekFrom::Start(snapshot.cursor.read_offset)).map_err(|_| "message observation unavailable")?;
    let mut appended = Vec::new();
    file.take(MAX_SEND_TAIL_BYTES + 1).read_to_end(&mut appended).map_err(|_| "message observation unavailable")?;
    if appended.len() as u64 > MAX_SEND_TAIL_BYTES { return Err("message observation unavailable".into()); }
    let read_end = snapshot.cursor.read_offset + appended.len() as u64;
    let mut bytes = std::mem::take(&mut snapshot.cursor.pending_bytes);
    bytes.extend_from_slice(&appended);
    let parsed = complete_line_records(&bytes, snapshot.cursor.committed_offset);
    let mut ignored_history = Vec::new();
    let (revision, skipped) = apply_decoded_records(&mut snapshot.adapter, &mut snapshot.reducer,
        &mut snapshot.events, &mut ignored_history, parsed.records, snapshot.brief.binding.source_revision);
    if skipped > 0 || parsed.skipped > 0 { return Err("message observation unavailable".into()); }
    let mut binding = snapshot.brief.binding.clone();
    binding.source_revision = revision;
    snapshot.brief = snapshot.reducer.to_brief(binding, "live", &service.service_epoch, unix_ms());
    snapshot.cursor.read_offset = read_end;
    snapshot.cursor.committed_offset = parsed.committed_end;
    snapshot.cursor.pending_bytes = parsed.pending_bytes;
    Ok(Some(snapshot))
}

fn same_source(snapshot: &SessionSnapshot, fence: &MessageSourceFence) -> bool {
    let current = &snapshot.brief.binding;
    let expected = &fence.binding;
    current.pty_session_id == expected.pty_session_id && current.agent_kind == expected.agent_kind
        && current.agent_session_id == expected.agent_session_id && current.pty_instance_id == expected.pty_instance_id
        && current.pty_generation == expected.pty_generation && snapshot.brief.service_epoch == fence.service_epoch
        && snapshot.cursor.stream_generation == fence.stream_generation
        && sha256_hex(snapshot.cursor.path.to_string_lossy().as_bytes()) == fence.path_hash
}

fn matching_input(snapshot: &SessionSnapshot, fence: &MessageSourceFence, text: &str) -> Option<String> {
    if snapshot.brief.telemetry_health != "live" || !same_source(snapshot, fence) { return None; }
    let expected_text = message_text(text);
    snapshot.events.iter().find_map(|event| {
        if event.source_revision <= fence.binding.source_revision || event.source_byte_start < fence.read_offset { return None; }
        match &event.kind {
            SemanticEventKind::UserMessage { text: accepted, .. } if accepted.trim() == expected_text.trim() => Some(event.event_id.clone()),
            _ => None,
        }
    })
}

/// Decode only the input shapes emitted by the existing composer. Do not
/// strip arbitrary escapes or normalize case, which could match another input.
fn message_text(text: &str) -> String {
    let text = text.strip_prefix("\u{1b}[200~").and_then(|text| text.strip_suffix("\u{1b}[201~")).unwrap_or(text);
    text.replace("\u{1b}[13;2u", "\n")
}

fn current_owner(service: &LiveBriefService, id: &str) -> (Option<String>, Option<String>) {
    service.metadata.get(id).map(|meta| (meta.agent_kind.clone(), meta.agent_session_id.clone())).unwrap_or_default()
}

fn source_file_identity(service: &LiveBriefService, id: &str) -> Option<String> {
    let path = service.state.lock().ok()?.sessions.get(id)?.cursor.path.clone();
    super::archive::file_identity(&File::open(path).ok()?).ok()
}

fn ownership_conflict(service: &LiveBriefService, guard: &MessageSendGuard) -> bool {
    let identity = service.manager.trusted_agent_identity(&guard.session_id);
    current_owner(service, &guard.session_id) != (guard.agent_kind.clone(), guard.agent_session_id.clone())
        || identity.as_ref().map(|identity| identity.agent_pid) != guard.agent_pid
        || identity.as_ref().map(|identity| identity.agent_started_at) != guard.agent_started_at
}

fn unique_conversation(service: &LiveBriefService, binding: &LiveBinding) -> bool {
    let ids: Vec<String> = service.manager.iter_pids().into_iter().map(|(id, _)| id).collect();
    agent_mappings_for_ids(ids).values().filter(|mapping|
        mapping.agent_kind.as_deref() == Some(binding.agent_kind.as_str()) && mapping.session_id == binding.agent_session_id
    ).count() == 1
}

#[tauri::command(async)]
pub async fn prepare_pane_message(
    _trusted: crate::ipc_caller::TrustedAppCaller,
    state: State<'_, AppState>, session_id: String, agent_message: bool, strict_revision: bool,
) -> Result<MessagePreparation, String> {
    let service = state.livebrief_service.clone();
    let store = state.session_state_store.clone();
    crate::util::task::run_blocking("prepare_pane_message", move || {
        let reject = |reason: &str| Ok(MessagePreparation { guard: None, reason: Some(reason.into()) });
        let Some((epoch, input_revision, _)) = service.manager.intervention_observation(&session_id) else { return reject("unknown_session"); };
        let file_identity = source_file_identity(&service, &session_id);
        let snapshot = match observe(&service, &session_id) { Ok(value) => value, Err(_) => return reject("observation_unavailable") };
        if source_file_identity(&service, &session_id) != file_identity { return reject("observation_unavailable"); }
        if snapshot.as_ref().is_some_and(has_pending_prompt) { return reject("pending_prompt"); }
        let (agent_kind, agent_session_id) = current_owner(&service, &session_id);
        let identity = service.manager.trusted_agent_identity(&session_id);
        let source = snapshot.as_ref().filter(|snapshot| snapshot.brief.telemetry_health == "live"
            && snapshot.brief.binding.pty_generation == epoch
            && agent_kind.as_deref() == Some(snapshot.brief.binding.agent_kind.as_str())
            && agent_session_id.as_deref() == Some(snapshot.brief.binding.agent_session_id.as_str())
            && identity.as_ref().is_some_and(|identity| identity.session_epoch == epoch
                && identity.kind == snapshot.brief.binding.agent_kind && identity.session_id == snapshot.brief.binding.agent_session_id))
            .and_then(|snapshot| {
                let file_identity = file_identity.clone()?;
                // Shared conversation files cannot prove which tab accepted an input.
                unique_conversation(&service, &snapshot.brief.binding).then(|| MessageSourceFence {
                    binding: snapshot.brief.binding.clone(), service_epoch: snapshot.brief.service_epoch.clone(),
                    path_hash: sha256_hex(snapshot.cursor.path.to_string_lossy().as_bytes()),
                    stream_generation: snapshot.cursor.stream_generation, read_offset: snapshot.cursor.read_offset,
                    file_identity,
                })
            });
        let supported = |kind: &str| matches!(kind, "claude" | "codex" | "claude-codex");
        let agent_message = agent_message || agent_kind.as_deref().is_some_and(supported)
            || identity.as_ref().is_some_and(|identity| supported(&identity.kind))
            || snapshot.as_ref().is_some_and(|snapshot| supported(&snapshot.brief.binding.agent_kind));
        let prepared = store.with_current_view(&session_id, |view| {
            if let Some(reason) = view_conflict(view, None) { return MessagePreparation { guard: None, reason: Some(reason.into()) }; }
            if view.session_epoch != Some(epoch) { return MessagePreparation { guard: None, reason: Some("session_epoch".into()) }; }
            MessagePreparation { guard: Some(MessageSendGuard {
                session_id: session_id.clone(), session_epoch: epoch, session_revision: view.session_revision, strict_revision,
                attention_id: view.attention.attention_id.clone(), input_revision, agent_kind, agent_session_id,
                agent_pid: identity.as_ref().map(|identity| identity.agent_pid),
                agent_started_at: identity.as_ref().map(|identity| identity.agent_started_at), agent_message, source,
            }), reason: None }
        });
        Ok(prepared.unwrap_or(MessagePreparation { guard: None, reason: Some("unknown_session".into()) }))
    }).await
}

#[tauri::command(async)]
pub async fn write_pane_message(
    _trusted: crate::ipc_caller::TrustedAppCaller,
    state: State<'_, AppState>, guard: MessageSendGuard, data: String, submit: bool,
) -> Result<MessageWriteResult, String> {
    let service = state.livebrief_service.clone();
    let store = state.session_state_store.clone();
    crate::util::task::run_blocking("write_pane_message", move || {
        let reject = |reason: &str| Ok(MessageWriteResult { sent: false, reason: Some(reason.into()) });
        if submit && data != "\r" { return reject("invalid_submit"); }
        if ownership_conflict(&service, &guard) { return reject("target_changed"); }
        if guard.source.as_ref().is_some_and(|fence| source_file_identity(&service, &guard.session_id).as_deref() != Some(fence.file_identity.as_str())) { return reject("target_changed"); }
        let observed = match observe(&service, &guard.session_id) { Ok(value) => value, Err(_) => return reject("observation_unavailable") };
        if observed.as_ref().is_some_and(has_pending_prompt) { return reject("pending_prompt"); }
        if guard.source.as_ref().is_some_and(|fence| observed.as_ref().is_none_or(|snapshot| !same_source(snapshot, fence))) { return reject("target_changed"); }
        if guard.source.as_ref().is_some_and(|fence| source_file_identity(&service, &guard.session_id).as_deref() != Some(fence.file_identity.as_str())) { return reject("target_changed"); }
        let Some(revision) = guard.input_revision.checked_add(u64::from(submit)) else { return reject("input_revision"); };
        let result = store.with_current_view(&guard.session_id, |view| {
            if let Some(reason) = view_conflict(view, Some(&guard)) { return Err(reason.to_string()); }
            // Hold canonical/cached prompt observations through queue insertion.
            // Epoch/input revision remain checked by the existing PTY input gate.
            let cache = service.state.lock().map_err(|_| "observation_unavailable".to_string())?;
            if cache.sessions.get(&guard.session_id).is_some_and(has_pending_prompt) { return Err("pending_prompt".into()); }
            let metadata = service.metadata.get(&guard.session_id);
            if metadata.as_ref().map(|meta| (meta.agent_kind.clone(), meta.agent_session_id.clone())).unwrap_or_default()
                != (guard.agent_kind.clone(), guard.agent_session_id.clone()) { return Err("target_changed".into()); }
            // The monitor publishes metadata while holding its identity lock.
            // Release this read before taking that lock in the manager.
            drop(metadata);
            let expected_agent = guard.agent_kind.as_deref().zip(guard.agent_session_id.as_deref())
                .zip(guard.agent_pid.zip(guard.agent_started_at)).map(|((kind, id), (pid, at))| (kind, id, pid, at));
            service.manager.write_message_if_revision(&guard.session_id, guard.session_epoch, revision, expected_agent, data.as_bytes())
        });
        let receiver = match result {
            Some(Ok(receiver)) => receiver,
            Some(Err(reason)) => return reject(&reason),
            None => return reject("unknown_session"),
        };
        match receiver.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(MessageWriteResult { sent: true, reason: None }),
            // Queue admission happened: never imply a retry is safe.
            _ => Err("入力を書き込んだ可能性があります。再送せず、対象の状態を確認してください。".into()),
        }
    }).await
}

#[tauri::command(async)]
pub async fn verify_pane_message(
    _trusted: crate::ipc_caller::TrustedAppCaller,
    state: State<'_, AppState>, guard: MessageSendGuard, text: String,
) -> Result<MessageVerification, String> {
    let service = state.livebrief_service.clone();
    crate::util::task::run_blocking("verify_pane_message", move || {
        let unchanged_input = service.manager.intervention_observation(&guard.session_id)
            .is_some_and(|(epoch, revision, _)| epoch == guard.session_epoch && guard.input_revision.checked_add(2) == Some(revision));
        let matched = guard.source.as_ref().filter(|fence| unchanged_input && !ownership_conflict(&service, &guard)
                && unique_conversation(&service, &fence.binding)
                && source_file_identity(&service, &guard.session_id).as_deref() == Some(fence.file_identity.as_str()))
            .and_then(|fence| observe(&service, &guard.session_id).ok().flatten()
                .filter(|_| source_file_identity(&service, &guard.session_id).as_deref() == Some(fence.file_identity.as_str()))
                .and_then(|snapshot| matching_input(&snapshot, fence, &text)));
        Ok(MessageVerification { confirmed: matched.is_some(), matched_event_id: matched })
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::adapter::UserMessageKind;

    fn picture() -> (SessionSnapshot, MessageSourceFence) {
        let binding = LiveBinding { pty_session_id: "target".into(), agent_session_id: "conversation".into(),
            agent_kind: "codex".into(), pty_instance_id: "pty-3".into(), pty_generation: 3,
            source_revision: 1, pty_input_revision: 7 };
        let mut snapshot = unavailable_snapshot(binding.clone(), "live", "service");
        snapshot.cursor.path = PathBuf::from("fixture.jsonl");
        let fence = MessageSourceFence { binding, service_epoch: "service".into(),
            path_hash: sha256_hex(b"fixture.jsonl"), stream_generation: 0, read_offset: 100, file_identity: "fixture".into() };
        (snapshot, fence)
    }

    fn user(id: &str, revision: u64, start: u64, text: &str) -> SemanticEventEnvelope {
        SemanticEventEnvelope { event_id: id.into(), source_revision: revision, occurred_at: 1,
            source_byte_start: start, source_byte_end: start + 10,
            kind: SemanticEventKind::UserMessage { kind: UserMessageKind::TaskStart, text: text.into(), digest: sha256_hex(text.as_bytes()) } }
    }

    #[test]
    fn repeated_text_needs_a_new_user_occurrence_after_the_fence() {
        let (mut snapshot, fence) = picture();
        snapshot.events.push_back(user("old", 1, 10, "repeat"));
        assert_eq!(matching_input(&snapshot, &fence, "repeat"), None);
        snapshot.events.push_back(user("new", 2, 100, "repeat"));
        assert_eq!(matching_input(&snapshot, &fence, "repeat"), Some("new".into()));
    }

    #[test]
    fn unrelated_output_partial_old_lines_and_case_changes_are_not_acceptance() {
        let (mut snapshot, fence) = picture();
        snapshot.events.push_back(user("partial-before-send", 2, 90, "repeat"));
        snapshot.events.push_back(user("different-case", 3, 110, "REPEAT"));
        snapshot.events.push_back(SemanticEventEnvelope { event_id: "output".into(), source_revision: 4,
            occurred_at: 2, source_byte_start: 120, source_byte_end: 130,
            kind: SemanticEventKind::AgentMessage { text: "repeat".into() } });
        assert_eq!(matching_input(&snapshot, &fence, "repeat"), None);
    }

    #[test]
    fn confirmation_does_not_cross_tabs_conversations_process_or_source_epochs() {
        let (mut snapshot, fence) = picture();
        snapshot.events.push_back(user("new", 2, 100, "repeat"));
        for change in 0..6 {
            let mut other = snapshot.clone();
            match change {
                0 => other.brief.binding.pty_session_id = "other-tab".into(),
                1 => other.brief.binding.agent_session_id = "other-conversation".into(),
                2 => other.brief.binding.pty_generation += 1,
                3 => other.brief.service_epoch = "new-service".into(),
                4 => other.cursor.stream_generation += 1,
                _ => other.cursor.path = PathBuf::from("replacement.jsonl"),
            }
            assert_eq!(matching_input(&other, &fence, "repeat"), None);
        }
    }

    #[test]
    fn existing_composer_input_shapes_match_the_actual_user_text() {
        let (mut snapshot, fence) = picture();
        snapshot.events.push_back(user("new", 2, 100, "日本語の依頼\n二行目"));
        assert!(matching_input(&snapshot, &fence, "\u{1b}[200~日本語の依頼\n二行目\u{1b}[201~").is_some());
        assert!(matching_input(&snapshot, &fence, "日本語の依頼\u{1b}[13;2u二行目").is_some());
    }

    #[test]
    fn pending_questions_and_approvals_block_without_caller_expectations() {
        for kind in [AttentionKind::Input, AttentionKind::Approval] {
            let mut view = SessionView::new("target"); view.attention.kind = kind;
            assert_eq!(view_conflict(&view, None), Some("pending_prompt"));
        }
    }

    #[test]
    fn replacement_at_the_same_path_retires_the_native_file_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.jsonl");
        let next = dir.path().join("replacement.jsonl");
        std::fs::write(&path, "same prefix\n").unwrap();
        let original = super::super::archive::file_identity(&File::open(&path).unwrap()).unwrap();
        std::fs::write(&next, "same prefix\nnew input\n").unwrap();
        std::fs::rename(&next, &path).unwrap();
        let replacement = super::super::archive::file_identity(&File::open(&path).unwrap()).unwrap();
        assert_ne!(original, replacement);
    }
}
