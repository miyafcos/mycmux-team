use std::collections::HashSet;

use super::adapter::{SemanticEventEnvelope, SemanticEventKind};
use super::{excerpt_ja, LiveSessionBrief};

const HEADING_VALUE_CHAR_LIMIT: usize = 400;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ContextExcerpt {
    pub text: String,
    pub chars: usize,
    pub events_included: usize,
    pub events_dropped: usize,
}

pub(crate) fn build_context_excerpt(
    brief: &LiveSessionBrief,
    events: &[SemanticEventEnvelope],
    max_chars: usize,
) -> Option<ContextExcerpt> {
    let headings = heading_lines(brief);
    let lines = event_lines(events);
    if headings.is_empty() && lines.is_empty() {
        return None;
    }

    let mut text = headings
        .into_iter()
        .chain(std::iter::once(excerpt_ja::CONVERSATION_DIVIDER.to_string()))
        .collect::<Vec<_>>()
        .join("\n");
    let fixed_chars = text.chars().count();
    if fixed_chars >= max_chars {
        text = text.chars().take(max_chars).collect();
        return Some(ContextExcerpt {
            chars: text.chars().count(),
            text,
            events_included: 0,
            events_dropped: lines.len(),
        });
    }

    let mut start = 0;
    while start < lines.len() {
        let mut candidate = lines[start..].to_vec();
        if start > 0 {
            candidate.insert(0, excerpt_ja::TRUNCATED_NOTE.to_string());
        }
        if chars_with_lines(&text, &candidate) <= max_chars || lines.len().saturating_sub(start) <= 1 {
            break;
        }
        start += 1;
    }
    let dropped = start;
    let mut kept = lines[start..].to_vec();
    if dropped > 0 {
        kept.insert(0, excerpt_ja::TRUNCATED_NOTE.to_string());
    }
    if chars_with_lines(&text, &kept) > max_chars {
        let note_chars = usize::from(dropped > 0)
            * (excerpt_ja::TRUNCATED_NOTE.chars().count() + 1);
        let available = max_chars.saturating_sub(fixed_chars + 1 + note_chars);
        if let Some(last) = kept.last_mut() {
            let count = last.chars().count();
            *last = last.chars().skip(count.saturating_sub(available)).collect();
        }
    }
    if !kept.is_empty() {
        text.push('\n');
        text.push_str(&kept.join("\n"));
    }
    let chars = text.chars().count();
    Some(ContextExcerpt {
        text,
        chars,
        events_included: lines.len().saturating_sub(dropped),
        events_dropped: dropped,
    })
}

fn heading_lines(brief: &LiveSessionBrief) -> Vec<String> {
    [
        (excerpt_ja::HEADING_STATE, Some(brief.operational_state.as_str())),
        (excerpt_ja::HEADING_AGENT, Some(brief.binding.agent_kind.as_str())),
        (excerpt_ja::HEADING_TASK, brief.task.as_deref()),
        (
            excerpt_ja::HEADING_LATEST_INSTRUCTION,
            brief.latest_instruction.as_deref(),
        ),
        (excerpt_ja::HEADING_CURRENT_POSITION, brief.activity_text.as_deref()),
        (excerpt_ja::HEADING_CHECKPOINT, brief.checkpoint.as_deref()),
        (excerpt_ja::HEADING_OPEN_QUESTION, brief.pending_prompt.as_deref()),
    ]
    .into_iter()
    .filter_map(|(heading, value)| {
        let value = value.map(collapse_line).map(cap_heading_value)?;
        (!value.is_empty()).then(|| format!("{heading} {value}"))
    })
    .collect()
}

fn event_lines(events: &[SemanticEventEnvelope]) -> Vec<String> {
    let completed: HashSet<&str> = events
        .iter()
        .filter_map(|event| match &event.kind {
            SemanticEventKind::ToolEnd { call_id, .. } => Some(call_id.as_str()),
            _ => None,
        })
        .collect();
    events
        .iter()
        .filter_map(|event| event_line(&event.kind, &completed))
        .collect()
}

fn event_line(kind: &SemanticEventKind, completed: &HashSet<&str>) -> Option<String> {
    let line = match kind {
        SemanticEventKind::UserMessage { text, .. } => format!("{} {text}", excerpt_ja::TAG_USER),
        SemanticEventKind::AgentMessage { text } => format!("{} {text}", excerpt_ja::TAG_AGENT),
        SemanticEventKind::ToolStart { call_id, tool, target } => {
            if completed.contains(call_id.as_str()) {
                return None;
            }
            tool_line(excerpt_ja::TAG_TOOL, tool, target.as_deref(), None)
        }
        SemanticEventKind::ToolEnd { tool, target, ok, summary, .. } => tool_line(
            excerpt_ja::TAG_TOOL,
            tool,
            target.as_deref(),
            Some((summary.as_deref(), *ok)),
        ),
        SemanticEventKind::Question { prompt, .. } => format!("{} {prompt}", excerpt_ja::TAG_QUESTION),
        SemanticEventKind::QuestionResolved { .. } => return None,
        SemanticEventKind::TestResult { pass, fail } => {
            format!("{} pass {pass} / fail {fail}", excerpt_ja::TAG_TEST)
        }
        SemanticEventKind::FileChange { path, change } => {
            format!("{} {path} {change}", excerpt_ja::TAG_FILE_CHANGE)
        }
        SemanticEventKind::Error { text, .. } => format!("{} {text}", excerpt_ja::TAG_ERROR),
    };
    Some(collapse_line(&line))
}

fn tool_line(
    tag: &str,
    tool: &str,
    target: Option<&str>,
    completion: Option<(Option<&str>, bool)>,
) -> String {
    let mut line = format!("{tag} {tool}");
    if let Some(target) = target.filter(|value| !value.trim().is_empty()) {
        line.push(' ');
        line.push_str(target);
    }
    if let Some((summary, ok)) = completion {
        if let Some(summary) = summary.filter(|value| !value.trim().is_empty()) {
            line.push_str(" -> ");
            line.push_str(summary);
        }
        line.push_str(&format!(
            " ({})",
            if ok { excerpt_ja::TOOL_OK } else { excerpt_ja::TOOL_FAILED }
        ));
    }
    line
}

fn collapse_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cap_heading_value(value: String) -> String {
    if value.chars().count() <= HEADING_VALUE_CHAR_LIMIT {
        return value;
    }
    let prefix = value
        .chars()
        .take(HEADING_VALUE_CHAR_LIMIT.saturating_sub(3))
        .collect::<String>();
    format!("{prefix}...")
}

fn chars_with_lines(prefix: &str, lines: &[String]) -> usize {
    if lines.is_empty() {
        prefix.chars().count()
    } else {
        prefix.chars().count() + 1 + lines.join("\n").chars().count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::livebrief::adapter::UserMessageKind;
    use crate::livebrief::{LiveBinding, PendingInputKind};

    fn brief() -> LiveSessionBrief {
        LiveSessionBrief {
            binding: LiveBinding { pty_session_id: "pty".to_string(), agent_session_id: "agent".to_string(), agent_kind: "codex".to_string(), pty_instance_id: "instance".to_string(), pty_generation: 1, source_revision: 1, pty_input_revision: 1 },
            task: Some("task".to_string()), latest_instruction: None, task_source_event_ids: Vec::new(), activity_kind: None, activity_text: None, activity_source_event_id: None,
            checkpoint: None, checkpoint_evidence_event_ids: Vec::new(), pending_input_kind: None, pending_prompt: None, pending_options: Vec::new(), prompt_event_id: None,
            prompt_hash: None, event_seq: 0, operational_state: "running".to_string(), telemetry_health: "ok".to_string(), last_event_at: None, last_successful_read_at: None,
            updated_at: 0, service_epoch: "epoch".to_string(), brief_revision: 0,
        }
    }

    fn event(id: &str, kind: SemanticEventKind) -> SemanticEventEnvelope {
        SemanticEventEnvelope { event_id: id.to_string(), source_revision: 1, occurred_at: 1, source_byte_start: 0, source_byte_end: 1, kind }
    }

    #[test]
    fn role_tags_and_chronological_order_are_preserved() {
        let events = vec![
            event("1", SemanticEventKind::UserMessage { kind: UserMessageKind::TaskStart, text: "user".to_string(), digest: String::new() }),
            event("2", SemanticEventKind::AgentMessage { text: "agent".to_string() }),
            event("3", SemanticEventKind::ToolEnd { call_id: "call".to_string(), tool: "read".to_string(), target: Some("file".to_string()), ok: true, summary: Some("done".to_string()) }),
            event("4", SemanticEventKind::Question { prompt_event_id: "question".to_string(), provider_call_id: "provider".to_string(), prompt: "question".to_string(), kind: PendingInputKind::FreeText, options: Vec::new() }),
            event("5", SemanticEventKind::TestResult { pass: 2, fail: 1 }),
            event("6", SemanticEventKind::FileChange { path: "file".to_string(), change: "updated".to_string() }),
            event("7", SemanticEventKind::Error { fingerprint: "error".to_string(), text: "failed".to_string() }),
        ];
        let text = build_context_excerpt(&brief(), &events, 12000).unwrap().text;
        let positions = [excerpt_ja::TAG_USER, excerpt_ja::TAG_AGENT, excerpt_ja::TAG_TOOL, excerpt_ja::TAG_QUESTION, excerpt_ja::TAG_TEST, excerpt_ja::TAG_FILE_CHANGE, excerpt_ja::TAG_ERROR]
            .map(|tag| text.find(tag).unwrap());
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn paired_tool_start_is_omitted_and_orphan_is_kept() {
        let events = vec![
            event("1", SemanticEventKind::ToolStart { call_id: "paired".to_string(), tool: "paired-tool".to_string(), target: None }),
            event("2", SemanticEventKind::ToolEnd { call_id: "paired".to_string(), tool: "paired-tool".to_string(), target: None, ok: true, summary: None }),
            event("3", SemanticEventKind::ToolStart { call_id: "orphan".to_string(), tool: "orphan-tool".to_string(), target: None }),
        ];
        let text = build_context_excerpt(&brief(), &events, 12000).unwrap().text;
        assert_eq!(text.matches("paired-tool").count(), 1);
        assert!(text.contains("orphan-tool"));
    }

    #[test]
    fn truncation_drops_oldest_lines_and_keeps_headings() {
        let events = vec![
            event("1", SemanticEventKind::UserMessage { kind: UserMessageKind::TaskStart, text: "old-old-old-old-old".to_string(), digest: String::new() }),
            event("2", SemanticEventKind::AgentMessage { text: "new-new-new-new-new".to_string() }),
        ];
        let full = build_context_excerpt(&brief(), &events, 12000).unwrap();
        let divider = full.text.find(excerpt_ja::CONVERSATION_DIVIDER).unwrap();
        let prefix_chars = full.text[..divider].chars().count();
        let limit = prefix_chars + excerpt_ja::CONVERSATION_DIVIDER.chars().count() + excerpt_ja::TRUNCATED_NOTE.chars().count() + 12;
        let result = build_context_excerpt(&brief(), &events, limit).unwrap();
        assert!(result.text.contains(excerpt_ja::HEADING_TASK));
        assert!(result.text.contains(excerpt_ja::TRUNCATED_NOTE));
        assert!(result.events_dropped > 0);
        assert!(result.chars <= limit);
    }

    #[test]
    fn multiline_agent_text_becomes_one_line() {
        let events = vec![event("1", SemanticEventKind::AgentMessage { text: "one\ntwo\tthree".to_string() })];
        let text = build_context_excerpt(&brief(), &events, 12000).unwrap().text;
        assert!(text.contains("one two three"));
        assert!(!text.contains("one\ntwo"));
    }

    #[test]
    fn empty_input_is_none_but_task_only_is_some() {
        let mut empty = brief();
        empty.binding.agent_kind.clear();
        empty.operational_state.clear();
        empty.task = None;
        assert!(build_context_excerpt(&empty, &[], 12000).is_none());
        empty.task = Some("task".to_string());
        assert!(build_context_excerpt(&empty, &[], 12000).is_some());
    }
}
