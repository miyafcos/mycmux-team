//! Read-only source context used to build an integrator handoff.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::livebrief::{LiveBriefService, LiveSessionBrief, LiveSessionEvents};

use super::{Criterion, EventId, LogicalSessionId, WorkItem};

/// A machine-derived snapshot of one source session. No field is inferred when
/// livebrief has no usable data for the session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDigest {
    pub logical_session_id: LogicalSessionId,
    pub label: Option<String>,
    pub snapshot_event_id: Option<EventId>,
    pub current_task: Option<String>,
    pub latest_instruction: Option<String>,
    pub activity: Option<String>,
    pub open_questions: Vec<String>,
    pub acquired: bool,
    pub failure_reason: Option<String>,
}

impl SourceDigest {
    fn unavailable(id: LogicalSessionId, reason: impl Into<String>) -> Self {
        Self {
            logical_session_id: id,
            label: None,
            snapshot_event_id: None,
            current_task: None,
            latest_instruction: None,
            activity: None,
            open_questions: Vec::new(),
            acquired: false,
            failure_reason: Some(reason.into()),
        }
    }
}

/// Refresh livebrief once, then read the in-memory event tails for the same
/// sessions. The logical id is intentionally treated as the PTY id here: there
/// is no second mapping in the WorkOrder authority.
pub fn build_source_digests(
    service: &LiveBriefService,
    ids: &[LogicalSessionId],
) -> Vec<SourceDigest> {
    let pty_ids = ids
        .iter()
        .map(|id| id.as_str().to_owned())
        .collect::<Vec<_>>();
    let snapshots = service.snapshots();
    let events = service.events(&pty_ids, 200);
    build_source_digests_from(&snapshots, &events, ids)
}

pub(crate) fn build_source_digests_from(
    snapshots: &[LiveSessionBrief],
    events: &[LiveSessionEvents],
    ids: &[LogicalSessionId],
) -> Vec<SourceDigest> {
    let briefs = snapshots
        .iter()
        .map(|brief| (brief.binding.pty_session_id.as_str(), brief))
        .collect::<HashMap<_, _>>();
    let tails = events
        .iter()
        .map(|tail| (tail.pty_session_id.as_str(), tail))
        .collect::<HashMap<_, _>>();

    ids.iter()
        .map(|id| {
            let Some(brief) = briefs.get(id.as_str()) else {
                return SourceDigest::unavailable(
                    id.clone(),
                    "no livebrief snapshot for PTY session",
                );
            };
            if !matches!(brief.telemetry_health.as_str(), "live" | "ended") {
                return SourceDigest::unavailable(
                    id.clone(),
                    format!("livebrief telemetry is {}", brief.telemetry_health),
                );
            }
            let snapshot_event_id = tails
                .get(id.as_str())
                .and_then(|tail| tail.events.last())
                .and_then(|event| EventId::try_new(&event.event_id).ok());
            SourceDigest {
                logical_session_id: id.clone(),
                label: None,
                snapshot_event_id,
                current_task: brief.task.clone(),
                latest_instruction: brief.latest_instruction.clone(),
                activity: brief.activity_text.clone(),
                open_questions: brief.pending_prompt.iter().cloned().collect(),
                acquired: true,
                failure_reason: None,
            }
        })
        .collect()
}

/// Render a deterministic handoff. It deliberately does not attempt to infer
/// decisions from event prose or make an LLM call.
pub fn render_integrator_prompt(
    goal: &str,
    digests: &[SourceDigest],
    criteria: &[Criterion],
) -> String {
    let unavailable = digests.iter().filter(|digest| !digest.acquired).count();
    let mut prompt = String::new();
    prompt.push_str("# 統合役への実行指示\n\n");
    prompt.push_str("## 目的\n");
    prompt.push_str(goal);
    prompt.push_str(&format!("\n\n## 素材{}件の現在地\n", digests.len()));
    for (index, digest) in digests.iter().enumerate() {
        prompt.push_str(&format!(
            "\n### 素材{}: {}\n",
            index + 1,
            digest.logical_session_id
        ));
        if let Some(label) = &digest.label {
            prompt.push_str(&format!("ラベル: {label}\n"));
        }
        if !digest.acquired {
            prompt.push_str("取得状態: 取得不可\n");
            prompt.push_str(&format!(
                "理由: {}\n",
                digest.failure_reason.as_deref().unwrap_or("理由なし")
            ));
            continue;
        }
        prompt.push_str("取得状態: 取得済み\n");
        prompt.push_str(&format!(
            "参照打ち切り位置: {}\n",
            digest
                .snapshot_event_id
                .as_ref()
                .map(EventId::as_str)
                .unwrap_or("記録なし")
        ));
        prompt.push_str(&format!(
            "現在の作業: {}\n",
            digest.current_task.as_deref().unwrap_or("取得情報なし")
        ));
        prompt.push_str(&format!(
            "最新の指示: {}\n",
            digest
                .latest_instruction
                .as_deref()
                .unwrap_or("取得情報なし")
        ));
        prompt.push_str(&format!(
            "活動: {}\n",
            digest.activity.as_deref().unwrap_or("取得情報なし")
        ));
    }
    prompt.push_str("\n## 未解決\n");
    let mut unresolved = false;
    for (index, digest) in digests.iter().enumerate() {
        for question in &digest.open_questions {
            unresolved = true;
            prompt.push_str(&format!(
                "- 素材{} ({}): {question}\n",
                index + 1,
                digest.logical_session_id
            ));
        }
    }
    if !unresolved {
        prompt.push_str("- なし\n");
    }
    prompt.push_str("\n## 決定済み\n");
    prompt.push_str("- 決定済み事項はまだ機械抽出できていないため、推測で補完しない。\n");
    if unavailable > 0 {
        prompt.push_str(&format!("\n取得できなかった素材: {unavailable}件\n"));
    }
    prompt.push_str("\n## 完了条件\n");
    for criterion in criteria {
        prompt.push_str(&format!("- {}: {}\n", criterion.id, criterion.description));
    }
    prompt
}

/// Render the sealed, item-specific instructions for a newly spawned worker.
/// It contains only plan data and does not infer work beyond the contract.
pub fn render_work_item_prompt(goal: &str, criteria: &[Criterion], item: &WorkItem) -> String {
    let mut prompt = String::new();
    prompt.push_str("# WorkOrder 作業指示\n\n");
    prompt.push_str("## ゴール\n");
    prompt.push_str(goal);
    prompt.push_str("\n\n## この作業\n");
    prompt.push_str(&item.objective);
    prompt.push_str("\n\n## 書込み範囲\n");
    if item.write_scope.is_empty() {
        prompt.push_str("- 指定なし\n");
    } else {
        for scope in &item.write_scope {
            prompt.push_str(&format!("- {}\n", scope.path_prefix));
            if let Some(worktree) = &scope.worktree {
                prompt.push_str(&format!("  - worktree: {worktree}\n"));
            }
            if let Some(branch) = &scope.branch {
                prompt.push_str(&format!("  - branch: {branch}\n"));
            }
        }
    }
    prompt.push_str("\n## 完了条件\n");
    for criterion in criteria {
        prompt.push_str(&format!("- {}: {}\n", criterion.id, criterion.description));
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::livebrief::{LiveBinding, LiveSessionBrief};

    fn session(value: &str) -> LogicalSessionId {
        LogicalSessionId::try_new(value).unwrap()
    }

    #[test]
    fn missing_brief_is_explicitly_unacquired() {
        let digests = build_source_digests_from(&[], &[], &[session("source-1")]);
        assert_eq!(digests.len(), 1);
        assert!(!digests[0].acquired);
        assert_eq!(
            digests[0].failure_reason.as_deref(),
            Some("no livebrief snapshot for PTY session")
        );
    }

    #[test]
    fn prompt_counts_unacquired_sources() {
        let digest = SourceDigest::unavailable(session("source-1"), "unavailable");
        let prompt = render_integrator_prompt(
            "goal",
            &[digest],
            &[Criterion {
                id: "c1".into(),
                description: "done".into(),
            }],
        );
        assert!(prompt.contains("取得できなかった素材: 1件"));
    }

    #[test]
    fn prompt_keeps_count_and_unresolved_items_in_top_level_sections() {
        let mut digest = SourceDigest::unavailable(session("source-1"), "unavailable");
        digest.open_questions = vec!["確認待ち".into()];
        let prompt = render_integrator_prompt(
            "goal",
            &[digest],
            &[Criterion {
                id: "c1".into(),
                description: "done".into(),
            }],
        );
        assert!(prompt.contains("## 素材1件の現在地"));
        assert!(prompt.contains("## 未解決\n- 素材1 (source-1): 確認待ち"));
        assert!(prompt.contains(
            "## 決定済み\n- 決定済み事項はまだ機械抽出できていないため、推測で補完しない。"
        ));
    }

    #[test]
    fn live_brief_maps_without_inference() {
        let brief = LiveSessionBrief {
            binding: LiveBinding {
                pty_session_id: "source-1".into(),
                agent_session_id: "agent".into(),
                agent_kind: "codex".into(),
                pty_instance_id: "instance".into(),
                pty_generation: 1,
                source_revision: 1,
                pty_input_revision: 0,
            },
            task: Some("task".into()),
            latest_instruction: Some("instruction".into()),
            task_source_event_ids: Vec::new(),
            activity_kind: None,
            activity_text: Some("activity".into()),
            activity_source_event_id: None,
            checkpoint: None,
            checkpoint_evidence_event_ids: Vec::new(),
            pending_input_kind: None,
            pending_prompt: Some("question".into()),
            pending_options: Vec::new(),
            prompt_event_id: None,
            prompt_hash: None,
            event_seq: 0,
            operational_state: "idle".into(),
            telemetry_health: "live".into(),
            last_event_at: None,
            last_successful_read_at: None,
            updated_at: 0,
            service_epoch: "epoch".into(),
            brief_revision: 0,
        };
        let digests = build_source_digests_from(&[brief], &[], &[session("source-1")]);
        assert!(digests[0].acquired);
        assert_eq!(digests[0].open_questions, vec!["question"]);
    }
}
