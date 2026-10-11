//! Turn boundaries, current-process tools and work that can resume Claude.
//! Unknown records and incomplete history never invent a completed session.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::adapter::{claude_user_starts_turn, parse_timestamp};

const EXPIRY_GRACE_MS: i64 = 60_000;
// The same one-minute wall-clock correction rule used by delegation observations.
const EVENT_CLOCK_ROLLBACK_MS: i64 = 60_000;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TurnState {
    #[default]
    Unknown,
    Idle,
    Active,
    Complete,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundState {
    #[default]
    Known,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionAutonomy {
    pub turn_state: TurnState,
    pub open_tool_count: usize,
    pub armed_background_count: usize,
    #[serde(default)]
    pub background_state: BackgroundState,
    #[serde(default)]
    pub pending_notification_count: usize,
    #[serde(default)]
    pub turn_started_at: Option<i64>,
}

#[derive(Clone, Debug)]
struct BackgroundWork {
    started_at: i64,
    expires_at: Option<i64>,
    scheduled: bool,
}

impl BackgroundWork {
    fn alive(&self, now: i64, start: Option<i64>) -> bool {
        current(self.started_at, start) && self.expires_at.is_none_or(|expiry| now <= expiry)
    }
}

#[derive(Clone, Debug)]
struct PendingNotification {
    task_id: String,
    delivery_id: Option<String>,
    // An anonymous duplicate remove cannot establish a definite delivery ID.
    provisional_remove_id: Option<String>,
    content: String,
    at: i64,
    ordinal: u64,
    user_delivered: bool,
    absorbed_delivered: bool,
    // A dequeue is queue handoff to a user record, not proof of model delivery.
    dequeued: bool,
    // Enqueues after the first receipt cannot be that receipt's second route.
    delivery_boundary: Option<u64>,
}

impl PendingNotification {
    fn delivered(&self) -> bool {
        self.user_delivered || self.absorbed_delivered
    }
}

#[derive(Clone, Debug)]
pub struct AutonomyTracker {
    turn: TurnState,
    turn_at: Option<i64>,
    turn_started_at: Option<i64>,
    open_tools: HashMap<String, i64>,
    tool_inputs: HashMap<String, (String, Value)>,
    background: HashMap<String, BackgroundWork>,
    background_known: bool,
    first_record_at: Option<i64>,
    pending_notifications: Vec<PendingNotification>,
    // Keep delivery proof with each enqueue, including IDs first seen on remove.
    next_notification_ordinal: u64,
    last_event_at: Option<i64>,
    // Raw time of a meaningful record decoded since the last poll, including
    // a smaller time after rollback. last_event_at alone holds the anchor.
    pending_source_event_at: Option<i64>,
}

impl Default for AutonomyTracker {
    fn default() -> Self {
        Self {
            turn: TurnState::Idle,
            turn_at: None,
            turn_started_at: None,
            open_tools: HashMap::new(),
            tool_inputs: HashMap::new(),
            background: HashMap::new(),
            background_known: true,
            first_record_at: None,
            pending_notifications: Vec::new(),
            next_notification_ordinal: 0,
            last_event_at: None,
            pending_source_event_at: None,
        }
    }
}

impl AutonomyTracker {
    pub fn mark_truncated_history(&mut self, has_background: bool) {
        self.turn = TurnState::Unknown;
        if has_background {
            self.background_known = false;
        }
    }

    pub fn snapshot(&self, now: i64, process_started_at: Option<i64>) -> SessionAutonomy {
        let turn_is_current = self
            .turn_at
            .is_none_or(|at| current(at, process_started_at));
        // If the available window predates process birth, it includes the whole
        // current process. Otherwise end_turn proves nothing about omitted work.
        let background_known = self.background_known
            || process_started_at
                .zip(self.first_record_at)
                .is_some_and(|(start, first)| start > first);
        SessionAutonomy {
            turn_state: if turn_is_current {
                self.turn
            } else {
                TurnState::Idle
            },
            open_tool_count: self
                .open_tools
                .values()
                .filter(|at| current(**at, process_started_at))
                .count(),
            armed_background_count: self
                .background
                .values()
                .filter(|work| work.alive(now, process_started_at))
                .count(),
            background_state: if background_known {
                BackgroundState::Known
            } else {
                BackgroundState::Unknown
            },
            pending_notification_count: self
                .pending_notifications
                .iter()
                .filter(|notice| current(notice.at, process_started_at) && !notice.delivered())
                .count(),
            turn_started_at: self
                .turn_started_at
                .filter(|at| current(*at, process_started_at)),
        }
    }

    pub fn last_event_at(&self) -> Option<i64> {
        self.last_event_at
    }

    pub fn record_activity(&mut self, at: i64) {
        self.pending_source_event_at = Some(at);
        self.last_event_at = Some(self.last_event_at.map_or(at, |prior| prior.max(at)));
    }

    pub fn event_clock_needs_rebase(&self, now: i64) -> bool {
        self.last_event_at.is_some_and(|at| at.saturating_sub(now) >= EVENT_CLOCK_ROLLBACK_MS)
    }

    fn rebase_event_clock(&mut self, now: i64) {
        if self.event_clock_needs_rebase(now) {
            // If a new record was decoded on the corrected clock before this
            // poll, retain its actual event time; otherwise start at this poll.
            self.last_event_at = Some(self.pending_source_event_at.filter(|at| *at <= now).unwrap_or(now));
        }
        self.pending_source_event_at = None;
    }

    // Called before decoding the replacement window, never after it.
    pub fn inherit_current_work(&mut self, previous: &Self, now: i64, start: Option<i64>) {
        for (id, work) in &previous.background {
            if work.alive(now, start) {
                self.background.insert(id.clone(), work.clone());
            }
        }
        for (id, at) in &previous.open_tools {
            if current(*at, start) {
                self.open_tools.insert(id.clone(), *at);
                if let Some(input) = previous.tool_inputs.get(id) {
                    self.tool_inputs.insert(id.clone(), input.clone());
                }
            }
        }
        self.pending_notifications.extend(
            previous
                .pending_notifications
                .iter()
                .filter(|notice| current(notice.at, start))
                .cloned(),
        );
        self.next_notification_ordinal = previous.next_notification_ordinal;
        if !previous.background_known
            && previous
                .first_record_at
                .is_none_or(|first| start.is_none_or(|s| s <= first))
        {
            self.background_known = false;
        }
    }

    pub fn prune(&mut self, now: i64, start: Option<i64>) {
        self.rebase_event_clock(now);
        self.background.retain(|_, work| work.alive(now, start));
        self.open_tools.retain(|_, at| current(*at, start));
        self.tool_inputs
            .retain(|id, _| self.open_tools.contains_key(id));
        self.pending_notifications
            .retain(|notice| current(notice.at, start));
        if self.turn_at.is_some_and(|at| !current(at, start)) {
            self.turn = TurnState::Idle;
            self.turn_at = None;
            self.turn_started_at = None;
        }
        if start
            .zip(self.first_record_at)
            .is_some_and(|(start, first)| start > first)
        {
            self.background_known = true;
        }
    }

    #[cfg(test)]
    pub fn retained_background_count(&self) -> usize {
        self.background.len()
    }

    pub fn observe(&mut self, provider: &str, value: &Value, at: i64) {
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return;
        }
        self.first_record_at = Some(self.first_record_at.map_or(at, |first| first.min(at)));
        let changed = match provider {
            "claude" => self.claude(value, at),
            "codex" => self.codex(value, at),
            _ => false,
        };
        if changed {
            self.record_activity(at);
        }
    }

    fn begin(&mut self, at: i64, explicit: bool) {
        if explicit || self.turn != TurnState::Active {
            self.turn_started_at = Some(at);
        }
        self.turn = TurnState::Active;
        self.turn_at = Some(at);
    }

    fn finish(&mut self, at: i64) -> bool {
        if self.turn == TurnState::Complete {
            return false; // A late turn_duration is the same completion.
        }
        self.turn = TurnState::Complete;
        self.turn_at = Some(at);
        true
    }

    fn abort(&mut self, at: i64) {
        self.finish(at);
        self.open_tools.clear();
        self.tool_inputs.clear();
        self.pending_notifications.clear();
    }

    fn close_tool(&mut self, id: &str, at: i64) -> bool {
        let _ = at;
        self.open_tools.remove(id).is_some()
    }

    fn codex(&mut self, value: &Value, at: i64) -> bool {
        let payload = value.get("payload").unwrap_or(value);
        match (string(value, "type"), string(payload, "type")) {
            (Some("event_msg"), Some("task_started")) => {
                self.begin(at, true);
                true
            }
            (Some("event_msg"), Some("task_complete")) => self.finish(at),
            (Some("event_msg"), Some("turn_aborted")) => {
                self.abort(at);
                true
            }
            (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
                if let Some(id) = string(payload, "call_id") {
                    self.open_tools.insert(id.to_owned(), at);
                    self.begin(at, false);
                    true
                } else {
                    false
                }
            }
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                string(payload, "call_id").is_some_and(|id| self.close_tool(id, at))
            }
            _ => false,
        }
    }

    fn claude(&mut self, value: &Value, at: i64) -> bool {
        let message = value.get("message").unwrap_or(value);
        match string(value, "type") {
            Some("system") if string(value, "subtype") == Some("turn_duration") => self.finish(at),
            Some("queue-operation") => {
                if string(value, "operation") == Some("dequeue") {
                    self.dequeue_notification(string(value, "content"), notification_delivery_id(value));
                    return false; // Handoff alone is neither delivery nor model activity.
                }
                if let Some(text) = string(value, "content") {
                    let enqueue = string(value, "operation") == Some("enqueue");
                    let absorbed = string(value, "operation") == Some("remove")
                        && string(value, "reason") == Some("absorbed_mid_turn");
                    let changed = self.notifications(
                        text,
                        at,
                        enqueue,
                        absorbed,
                        notification_delivery_id(value),
                        true,
                    );
                    if absorbed && text.contains("<task-notification>") {
                        self.begin(at, false);
                        return true;
                    }
                    changed
                } else {
                    // dequeue hands off the message; it does not prove that the
                    // model has processed it. Keep it until user/absorption.
                    false
                }
            }
            Some("assistant") => {
                let mut recognized = false;
                if let Some(parts) = message.get("content").and_then(Value::as_array) {
                    for part in parts {
                        if string(part, "type") == Some("tool_use") {
                            if let Some(id) = string(part, "id") {
                                self.open_tools.insert(id.to_owned(), at);
                                if let Some(tool) = string(part, "name") {
                                    self.tool_inputs.insert(
                                        id.to_owned(),
                                        (
                                            tool.to_owned(),
                                            part.get("input").cloned().unwrap_or(Value::Null),
                                        ),
                                    );
                                }
                                recognized = true;
                            }
                        } else if matches!(string(part, "type"), Some("text" | "thinking")) {
                            recognized = true;
                        }
                    }
                }
                if string(message, "stop_reason") == Some("end_turn") {
                    return self.finish(at);
                }
                if recognized {
                    self.begin(at, false);
                }
                recognized
            }
            Some("user") => {
                let mut recognized = false;
                let mut text = Vec::new();
                if let Some(content) = message.get("content").and_then(Value::as_str) {
                    text.push(content);
                } else if let Some(parts) = message.get("content").and_then(Value::as_array) {
                    for part in parts {
                        match string(part, "type") {
                            Some("text") => {
                                if let Some(content) = string(part, "text") {
                                    text.push(content);
                                }
                            }
                            Some("tool_result") => {
                                if let Some(id) = string(part, "tool_use_id") {
                                    self.close_tool(id, at);
                                    self.arm_result(
                                        id,
                                        value.get("toolUseResult"),
                                        part.get("is_error").and_then(Value::as_bool) == Some(true),
                                        at,
                                    );
                                    recognized = true;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if text.join("\n").trim_start().starts_with("[Request interrupted by user") {
                    self.abort(at);
                    return true;
                }
                for content in text {
                    if claude_user_starts_turn(value, content) {
                        self.notifications(
                            content,
                            at,
                            false,
                            true,
                            notification_delivery_id(value),
                            false,
                        );
                        self.begin(at, true);
                        recognized = true;
                    }
                }
                recognized
            }
            Some("tool_result") => {
                if let Some(id) =
                    string(value, "tool_use_id").or_else(|| string(value, "toolUseId"))
                {
                    self.close_tool(id, at);
                    self.arm_result(
                        id,
                        value.get("toolUseResult"),
                        value.get("is_error").and_then(Value::as_bool) == Some(true),
                        at,
                    );
                    true
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    fn arm_result(&mut self, call_id: &str, result: Option<&Value>, failed: bool, at: i64) {
        let tool = self.tool_inputs.remove(call_id);
        let Some(result) = result else { return };
        if failed
            || result.get("success").and_then(Value::as_bool) == Some(false)
            || result.get("error").is_some()
        {
            return;
        }
        if let Some(id) = string(result, "backgroundTaskId") {
            self.arm(id.to_owned(), at, None, false);
        }
        if let Some(id) = string(result, "taskId") {
            if result.get("persistent").and_then(Value::as_bool).is_some() {
                let expiry = result
                    .get("timeoutMs")
                    .and_then(Value::as_i64)
                    .filter(|ms| *ms >= 0)
                    .map(|ms| at.saturating_add(ms).saturating_add(EXPIRY_GRACE_MS));
                self.arm(id.to_owned(), at, expiry, false);
            }
        }
        if result.get("isAsync").and_then(Value::as_bool) == Some(true) {
            if let Some(id) = string(result, "agentId") {
                self.arm(id.to_owned(), at, None, false);
            }
        }
        if let Some(scheduled) = string(result, "scheduledFor").and_then(parse_timestamp) {
            self.arm(
                format!("wakeup:{call_id}"),
                at,
                Some(scheduled.saturating_add(EXPIRY_GRACE_MS)),
                true,
            );
        }
        if let Some((name, input)) = tool {
            if name == "TaskStop" {
                if let Some(id) =
                    string(result, "task_id").filter(|id| string(&input, "task_id") == Some(*id))
                {
                    let message = string(result, "message")
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    let stopped = result.get("stopped").and_then(Value::as_bool) == Some(true)
                        || result.get("success").and_then(Value::as_bool) == Some(true)
                        || (string(result, "task_type").is_some()
                            && (message.starts_with("successfully stopped")
                                || message.starts_with("successfully killed")));
                    if stopped {
                        self.background.remove(id);
                    }
                }
            }
            if name == "ScheduleWakeup"
                && result.get("stopped").and_then(Value::as_bool) == Some(true)
            {
                self.background.retain(|_, work| !work.scheduled);
            }
        }
    }

    fn arm(&mut self, id: String, at: i64, expires_at: Option<i64>, scheduled: bool) {
        self.background.insert(
            id,
            BackgroundWork {
                started_at: at,
                expires_at,
                scheduled,
            },
        );
    }

    fn dequeue_notification(&mut self, text: Option<&str>, delivery_id: Option<&str>) {
        let content = text.and_then(|text| text.split_once("<task-notification>"))
            .map(|(_, block)| super::sha256_hex(block.split("</task-notification>").next().unwrap_or(block).as_bytes()));
        let eligible = |notice: &PendingNotification| !notice.delivered() && !notice.dequeued
            && content.as_ref().is_none_or(|content| notice.content == *content)
            && (delivery_id.is_none() || notice.delivery_id.is_none() || notice.delivery_id.as_deref() == delivery_id);
        let identified = delivery_id.and_then(|id| self.pending_notifications.iter()
            .position(|notice| eligible(notice) && notice.delivery_id.as_deref() == Some(id)));
        if let Some(index) = identified.or_else(|| self.pending_notifications.iter().position(eligible)) {
            let notice = &mut self.pending_notifications[index];
            notice.dequeued = true;
            if notice.delivery_id.is_none() { notice.delivery_id = delivery_id.map(str::to_owned); }
            if let Some(delivery) = delivery_id {
                self.revoke_provisional_remove(index, delivery);
            }
        }
    }

    fn revoke_provisional_remove(&mut self, handoff: usize, delivery: &str) {
        let task = self.pending_notifications[handoff].task_id.clone();
        let content = self.pending_notifications[handoff].content.clone();
        for (index, notice) in self.pending_notifications.iter_mut().enumerate() {
            if index != handoff && notice.task_id == task && notice.content == content
                && notice.provisional_remove_id.as_deref() == Some(delivery)
            {
                notice.provisional_remove_id = None;
                // The old anonymous user receipt stays delivered. Only its
                // guessed second route is revoked by the definite handoff.
                notice.absorbed_delivered = false;
            }
        }
    }

    fn notifications(
        &mut self,
        text: &str,
        at: i64,
        enqueue: bool,
        delivered: bool,
        delivery_id: Option<&str>,
        absorbed: bool,
    ) -> bool {
        let mut changed = false;
        for rest in text.split("<task-notification>").skip(1) {
            let block = rest.split("</task-notification>").next().unwrap_or(rest);
            let Some(id) = tag(block, "task-id") else {
                continue;
            };
            let known = self.background.contains_key(id)
                || self
                    .pending_notifications
                    .iter()
                    .any(|notice| notice.task_id == id);
            let content = super::sha256_hex(block.as_bytes());
            if enqueue
                && known
                && !self.pending_notifications.iter().any(|notice| {
                    notice.task_id == id
                        && notice.content == content
                        && delivery_id.is_some()
                        && notice.delivery_id.as_deref() == delivery_id
                })
            {
                self.pending_notifications.push(PendingNotification {
                    task_id: id.to_owned(),
                    delivery_id: delivery_id.map(str::to_owned),
                    provisional_remove_id: None,
                    content: content.clone(),
                    at,
                    ordinal: self.next_notification_ordinal,
                    user_delivered: false,
                    absorbed_delivered: false,
                    dequeued: false,
                    delivery_boundary: None,
                });
                self.next_notification_ordinal += 1;
                changed = true;
            }
            if matches!(
                tag(block, "status"),
                Some("completed" | "killed" | "failed" | "stopped")
            ) {
                changed |= self.background.remove(id).is_some();
            }
            if delivered {
                let same_content = |notice: &PendingNotification| {
                    notice.task_id == id && notice.content == content
                };
                let identified = delivery_id.and_then(|delivery| {
                    self.pending_notifications.iter().position(|notice| {
                        same_content(notice) && notice.delivery_id.as_deref() == Some(delivery)
                    })
                });
                let pending = self.pending_notifications.iter().position(|notice| {
                    same_content(notice)
                        && !notice.delivered()
                        && (delivery_id.is_none()
                            || notice.delivery_id.is_none()
                            || notice.delivery_id.as_deref() == delivery_id)
                });
                // A pending dequeue supplies evidence for a later user handoff.
                // It does not identify an anonymous remove after that receipt.
                let handed_off = (!absorbed).then(|| self.pending_notifications.iter().position(|notice| {
                    same_content(notice) && !notice.delivered() && notice.dequeued
                        && (delivery_id.is_none() || notice.delivery_id.is_none() || notice.delivery_id.as_deref() == delivery_id)
                })).flatten();
                let provisional = delivery_id.and_then(|delivery| {
                    self.pending_notifications.iter().position(|notice| {
                        same_content(notice) && notice.provisional_remove_id.as_deref() == Some(delivery)
                    })
                });
                // K1: without a linking delivery ID, a later same-content remove
                // can be A's duplicate or B's first receipt. Keep possible B
                // pending rather than infer its delivery from A's dequeue alone.
                // Identified receipts and pending user handoffs still win. A
                // completed turn's existing 30-minute display safety net bounds
                // this uncertainty if B never gets a distinguishable receipt.
                let other_route = self.pending_notifications.iter().position(|notice| {
                    same_content(notice)
                        && notice.delivered()
                        && if absorbed {
                            !notice.absorbed_delivered
                        } else {
                            !notice.user_delivered
                        }
                        && (delivery_id.is_none()
                            || notice.delivery_id.is_none()
                            || notice.delivery_id.as_deref() == delivery_id)
                        && pending.is_none_or(|index| {
                            let pending = &self.pending_notifications[index];
                            pending.ordinal < notice.delivery_boundary.unwrap()
                        })
                });
                // L1: definite IDs still win over every handoff. A provisional
                // remove ID cannot shadow a later pending handoff with that ID.
                if let Some(index) = identified.or(handed_off).or(provisional).or(other_route).or(pending) {
                    let notice = &mut self.pending_notifications[index];
                    let was_delivered = notice.delivered();
                    if notice.delivery_id.is_none() {
                        if (absorbed && other_route == Some(index)) || provisional == Some(index) {
                            notice.provisional_remove_id = delivery_id.map(str::to_owned);
                        } else {
                            notice.delivery_id = delivery_id.map(str::to_owned);
                        }
                    }
                    if absorbed {
                        notice.absorbed_delivered = true;
                    } else {
                        notice.user_delivered = true;
                    }
                    notice
                        .delivery_boundary
                        .get_or_insert(self.next_notification_ordinal);
                    changed |= !was_delivered;
                }
            }
        }
        changed
    }
}

fn notification_delivery_id(value: &Value) -> Option<&str> {
    string(value, "commandUuid")
        .or_else(|| string(value, "deliveryId"))
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| string(message, "commandUuid"))
        })
}

fn current(at: i64, start: Option<i64>) -> bool {
    start.is_none_or(|start| at >= start)
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.split_once(&format!("<{name}>"))?
        .1
        .split_once(&format!("</{name}>"))
        .map(|(value, _)| value.trim())
}
