//! Immutable release coordinates and a bounded, receiver-authenticated escrow.
//! The OS move is already closed; hover commands never access this state.
use super::{Approval, MoveMode};
#[cfg(test)]
use super::release_latch::ReleaseLatch;
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::{Duration, Instant}};
use tokio::sync::oneshot;

pub const RESOLVE_LIMIT: Duration = Duration::from_millis(250);
pub const ESCROW_LIMIT: Duration = Duration::from_secs(6);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseMethod { NativeUp, NativeExit, PollFallback, Synthetic }
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleasePoint { pub x: f64, pub y: f64, pub at: u64, pub method: ReleaseMethod }

#[derive(Clone, Serialize)]
pub struct ReleaseFrame {
    pub id: String, pub mode: MoveMode, pub label: String, pub source: String, pub receiver: String,
    pub receiver_epoch: u64, pub region_count: usize, pub client_x: f64, pub client_y: f64,
    pub point: ReleasePoint, pub token: String,
}
type Answer = Result<Option<Approval>, String>;
enum Status {
    Fresh,
    Requested { answer: oneshot::Sender<Answer>, deadline: Instant, claimed: bool },
    Approved(Approval),
    Finished,
}
pub struct ReleaseEscrow { pub frame: ReleaseFrame, receiver_geometry: Option<serde_json::Value>, created: Instant, resolution_deadline: Instant, status: Mutex<Status> }
impl ReleaseEscrow {
    #[cfg(test)]
    pub fn new(frame: ReleaseFrame) -> Self { Self::with_elapsed(frame, Duration::ZERO) }
    pub fn with_elapsed(frame: ReleaseFrame, elapsed: Duration) -> Self {
        let created = Instant::now();
        Self { frame, receiver_geometry: None, created, resolution_deadline: created + RESOLVE_LIMIT.saturating_sub(elapsed), status: Mutex::new(Status::Fresh) }
    }
    pub fn with_geometry(mut self, geometry: serde_json::Value) -> Self { self.receiver_geometry = Some(geometry); self }
    pub fn matches_geometry(&self, geometry: &serde_json::Value) -> bool { self.receiver_geometry.as_ref().is_none_or(|expected| expected == geometry) }
    pub fn remaining(&self) -> Duration { self.resolution_deadline.saturating_duration_since(Instant::now()) }
    pub fn expired(&self) -> bool { self.created.elapsed() >= ESCROW_LIMIT }
    pub fn request(&self, source: &str) -> Result<oneshot::Receiver<Answer>, String> {
        if !self.frame.mode.allows_dock() { return Err("tearout_detach_has_no_drop".into()); }
        if source != self.frame.source { return Err("tearout_release_source_invalid".into()); }
        let mut status = self.status.lock().map_err(|e| e.to_string())?;
        if self.expired() || self.remaining().is_zero() || !matches!(*status, Status::Fresh) { return Err("tearout_release_expired".into()); }
        let (answer, wait) = oneshot::channel();
        *status = Status::Requested { answer, deadline: self.resolution_deadline, claimed: false };
        Ok(wait)
    }
    fn authenticates(&self, receiver: &str, epoch: u64) -> bool {
        self.frame.mode.allows_dock() && receiver == self.frame.receiver && epoch == self.frame.receiver_epoch && !self.expired()
    }
    pub fn begin(&self, receiver: &str, epoch: u64) -> Result<ReleaseFrame, String> {
        if !self.authenticates(receiver, epoch) { return Err("tearout_release_receiver_invalid".into()); }
        let mut status = self.status.lock().map_err(|e| e.to_string())?;
        match &mut *status {
            Status::Requested { deadline, claimed, .. } if Instant::now() < *deadline && !*claimed => {
                *claimed = true; Ok(self.frame.clone())
            }
            _ => Err("tearout_release_expired".into()),
        }
    }
    pub fn painting(&self) -> bool {
        !self.expired() && self.status.lock().is_ok_and(|status| matches!(*status,
            Status::Requested { deadline, claimed: true, .. } if Instant::now() < deadline))
    }
    pub fn pending_for(&self, label: &str) -> bool {
        self.frame.label == label && !self.expired() && self.status.lock().is_ok_and(|s| !matches!(*s, Status::Finished))
    }
    pub fn decide(&self, receiver: &str, epoch: u64, token: Option<String>, target: Option<serde_json::Value>,
        revision: Option<String>, error: Option<String>) -> Result<bool, String> {
        if !self.authenticates(receiver, epoch) { return Ok(false); }
        let mut status = self.status.lock().map_err(|e| e.to_string())?;
        if !matches!(*status, Status::Requested { deadline, claimed: true, .. } if Instant::now() < deadline) { return Ok(false); }
        let answer = match (error, target) {
            (Some(error), _) => Err(error.chars().take(128).collect()),
            (None, None) if token.is_none() && revision.is_none() => Ok(None),
            (None, Some(target)) if token.as_deref() == Some(self.frame.token.as_str())
                && revision.as_ref().is_some_and(|r| !r.is_empty() && r.len() <= 131_072)
                && valid_target(&target, self.frame.region_count) => Ok(Some(Approval {
                    receiver: self.frame.receiver.clone(), token: self.frame.token.clone(), target,
                    release_id: Some(self.frame.id.clone()), layout_revision: revision,
                })),
            _ => Err("tearout_release_decision_invalid".into()),
        };
        let old = std::mem::replace(&mut *status, match &answer {
            Ok(Some(approval)) => Status::Approved(approval.clone()), _ => Status::Finished,
        });
        if let Status::Requested { answer: sender, .. } = old {
            if sender.send(answer).is_ok() { return Ok(true); }
        }
        *status = Status::Finished;
        Ok(false)
    }
    pub fn consume(&self, receiver: &str, token: &str, target: &serde_json::Value, revision: &str) -> bool {
        if receiver != self.frame.receiver || self.expired() { return false; }
        let Ok(mut status) = self.status.lock() else { return false; };
        if matches!(&*status, Status::Approved(approval) if approval.token == token && approval.target == *target
            && approval.layout_revision.as_deref() == Some(revision)) {
            *status = Status::Finished; true
        } else { false }
    }
    pub fn cancel(&self) { if let Ok(mut status) = self.status.lock() { *status = Status::Finished; } }
}
fn valid_target(target: &serde_json::Value, regions: usize) -> bool {
    let identifier = |key: &str| target[key].as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128);
    match target["kind"].as_str() {
        Some("workspace") => true,
        _ if regions > 1 => false,
        Some("tab-index") => identifier("workspaceId") && identifier("paneId") && target["index"].as_u64().is_some_and(|n| n <= 100_000),
        Some("pane-zone") => identifier("workspaceId") && identifier("paneId")
            && matches!(target["zone"].as_str(), Some("center" | "left" | "right" | "up" | "down")),
        Some("handoff") => identifier("workspaceId") && identifier("paneId") && identifier("tabId") && identifier("sessionId")
            && matches!(target["targetAgentKind"].as_str(), Some("claude" | "codex" | "claude-codex" | "grok")),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn point(x: f64, method: ReleaseMethod) -> ReleasePoint { ReleasePoint { x, y: -200.5, at: 10, method } }
    fn escrow() -> ReleaseEscrow {
        ReleaseEscrow::new(ReleaseFrame { id: "drag".into(), mode: MoveMode::Dock, label: "moving".into(), source: "source".into(), receiver: "receiver".into(),
            receiver_epoch: 4, region_count: 1, client_x: 100.25, client_y: 50.5, point: point(-1200.5, ReleaseMethod::NativeUp), token: "one-use".into() })
    }
    fn target() -> serde_json::Value { serde_json::json!({ "kind": "pane-zone", "workspaceId": "w", "paneId": "p", "zone": "center" }) }
    #[test]
    fn native_up_and_exit_survive_cursor_movement_before_poll_r10() {
        for method in [ReleaseMethod::NativeUp, ReleaseMethod::NativeExit] {
            let latch = ReleaseLatch::default(); latch.latch(point(1.25, method));
            assert_eq!(latch.final_point(point(900.0, ReleaseMethod::PollFallback)), point(1.25, method));
        }
        let omitted = ReleaseLatch::default();
        assert_eq!(omitted.final_point(point(300.0, ReleaseMethod::PollFallback)).method, ReleaseMethod::PollFallback);
        assert_eq!(ReleaseLatch::default().final_point(point(900.0, ReleaseMethod::PollFallback)).x, 900.0);
    }
    #[test]
    fn removed_move_can_resolve_once_with_receiver_authentication_r3_r11() {
        let escrow = escrow();
        assert!(escrow.request("forged").is_err());
        let mut wait = escrow.request("source").unwrap();
        assert!(escrow.request("source").is_err());
        assert!(escrow.begin("forged", 4).is_err()); assert!(escrow.begin("receiver", 3).is_err());
        assert_eq!(escrow.begin("receiver", 4).unwrap().point.x, -1200.5);
        assert!(escrow.begin("receiver", 4).is_err()); assert!(escrow.painting());
        assert!(!escrow.decide("forged", 4, Some("one-use".into()), Some(target()), Some("layout".into()), None).unwrap());
        assert!(escrow.decide("receiver", 4, Some("one-use".into()), Some(target()), Some("layout".into()), None).unwrap());
        let approval = wait.try_recv().unwrap().unwrap().unwrap();
        assert_eq!(approval.release_id.as_deref(), Some("drag")); assert!(!escrow.painting());
        assert!(!escrow.decide("receiver", 4, None, None, None, None).unwrap());
        assert!(!escrow.consume("forged", "one-use", &target(), "layout"));
        assert!(!escrow.consume("receiver", "one-use", &target(), "changed-layout"));
        assert!(escrow.consume("receiver", "one-use", &target(), "layout"));
        assert!(!escrow.consume("receiver", "one-use", &target(), "layout"));
    }
    #[test]
    fn invalid_target_and_cancel_never_become_success_r6_r8() {
        let escrow = escrow(); let mut wait = escrow.request("source").unwrap(); escrow.begin("receiver", 4).unwrap();
        assert!(escrow.decide("receiver", 4, None, None, None, Some("tearout_drop_target_changed".into())).unwrap());
        assert_eq!(wait.try_recv().unwrap().err().as_deref(), Some("tearout_drop_target_changed"));
        assert!(!escrow.painting()); assert!(!escrow.consume("receiver", "one-use", &target(), "layout"));
        let escrow = self::escrow(); let mut wait = escrow.request("source").unwrap(); escrow.cancel();
        assert!(wait.try_recv().is_err()); assert!(escrow.begin("receiver", 4).is_err());
    }
    #[test]
    fn receiver_identity_origin_size_and_dpi_must_still_match_r5_r6() {
        let geometry = serde_json::json!({"window":42,"origin":[-2560,-1440],"size":[2560,1440],"scale":1.25});
        let release = escrow().with_geometry(geometry.clone());
        assert!(release.matches_geometry(&geometry));
        for (key, value) in [("window", serde_json::json!(43)), ("origin", serde_json::json!([-2500,-1440])),
            ("size", serde_json::json!([1280,720])), ("scale", serde_json::json!(2.0))] {
            let mut changed = geometry.clone(); changed[key] = value; assert!(!release.matches_geometry(&changed));
        }
    }
    #[test]
    fn resolution_deadline_starts_at_native_release_not_a_late_renderer_request_r8_r11() {
        let aged = ReleaseEscrow::with_elapsed(escrow().frame, RESOLVE_LIMIT);
        assert!(aged.remaining().is_zero()); assert!(aged.request("source").is_err());
        assert!(aged.begin("receiver", 4).is_err()); assert!(!aged.painting());
    }
    #[test]
    fn group_shape_and_token_are_checked_r7_r11() {
        assert!(valid_target(&target(), 1)); assert!(!valid_target(&target(), 2));
        assert!(valid_target(&serde_json::json!({"kind":"workspace"}), 2));
        let escrow = escrow(); let mut wait = escrow.request("source").unwrap(); escrow.begin("receiver", 4).unwrap();
        escrow.decide("receiver", 4, Some("stale-hover".into()), Some(target()), Some("layout".into()), None).unwrap();
        assert_eq!(wait.try_recv().unwrap().err().as_deref(), Some("tearout_release_decision_invalid"));
    }
    #[test]
    fn detach_cannot_resolve_or_expose_a_drop_o2() {
        let mut frame = escrow().frame;
        frame.mode = MoveMode::Detach;
        let release = ReleaseEscrow::new(frame);
        assert!(release.request("source").is_err());
        assert!(release.begin("receiver", 4).is_err());
        assert!(!release.decide("receiver", 4, Some("one-use".into()), Some(target()), Some("layout".into()), None).unwrap());
        assert!(!release.painting());
        assert!(!release.consume("receiver", "one-use", &target(), "layout"));
    }
}
