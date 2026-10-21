use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Prepared,
    Shown,
    Committed,
    Received,
    Cleaned,
    RolledBack,
}

#[derive(Debug)]
pub struct Transfer {
    pub source: String,
    pub receiver: String,
    pub finalizer: String,
    pub delivery_token: String,
    pub finalized: bool,
    pub configs: Vec<serde_json::Value>,
    pub phase: Phase,
    pub(crate) attachment_source: Option<super::attachment_epoch::WindowProof>,
    pub(crate) attachment_receiver: Option<super::attachment_epoch::WindowProof>,
    pub(crate) attachments_revoked: bool,
    pub(crate) attachments_revoking: bool,
}

impl Transfer {
    pub fn new(
        source: String,
        receiver: String,
        configs: Vec<serde_json::Value>,
        delivery_token: String,
        finalizer: Option<String>,
    ) -> Self {
        Self {
            finalizer: finalizer.unwrap_or_else(|| source.clone()),
            source,
            receiver,
            delivery_token,
            finalized: false,
            configs,
            phase: Phase::Prepared,
            attachment_source: None, attachment_receiver: None, attachments_revoked: false, attachments_revoking: false,
        }
    }

    /// Receipt/cleanup are not the source's commit decision. The receiver may
    /// not pass provisional sessions onward even after the native loop ends.
    pub fn reserved(&self) -> bool {
        !self.finalized && self.phase != Phase::RolledBack
    }
    pub fn reserves_window(&self, label: &str) -> bool {
        self.reserved() && self.receiver == label
    }
    pub fn reserves_sessions(&self, configs: &[serde_json::Value]) -> bool {
        self.reserved() && !session_ids(&self.configs).is_disjoint(&session_ids(configs))
    }
    pub fn authorize(&self, caller: &str) -> Result<(), String> {
        if caller == self.source || caller == self.finalizer {
            Ok(())
        } else {
            Err("tearout_transfer_source_changed".into())
        }
    }
    pub fn check_finalize(&self, caller: &str, token: &str) -> Result<(), String> {
        self.authorize(caller)?;
        if self.delivery_token != token {
            return Err("tearout_transfer_token_changed".into());
        }
        if self.phase != Phase::Cleaned {
            return Err("tearout_transfer_not_complete".into());
        }
        Ok(())
    }
    pub fn can_forget(&self) -> bool {
        self.finalized || self.phase == Phase::RolledBack
    }

    /// A repeated rollback cannot revoke a restored session a second time.
    pub fn advance(&mut self, next: Phase) -> Result<bool, String> {
        if self.finalized {
            return Err("tearout_transfer_finalized".into());
        }
        if self.phase == next {
            return Ok(false);
        }
        if self.phase == Phase::RolledBack {
            return Err("tearout_transfer_already_rolled_back".into());
        }
        let valid = matches!(
            (self.phase, next),
            (Phase::Prepared, Phase::Shown)
                | (Phase::Shown, Phase::Committed)
                | (Phase::Committed, Phase::Received)
                | (Phase::Received, Phase::Cleaned)
        ) || next == Phase::RolledBack;
        if !valid {
            return Err("tearout_invalid_transfer_phase".into());
        }
        self.phase = next;
        Ok(true)
    }
}

pub(super) fn session_ids(configs: &[serde_json::Value]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for pane in configs.iter().filter_map(|config| config.get("panes").and_then(|v| v.as_array())).flatten() {
        if let Some(tabs) = pane.get("tabs").and_then(|v| v.as_array()) {
            for tab in tabs {
                if let Some(id) = tab.get("session_id").and_then(|v| v.as_str()).filter(|id| !id.is_empty()) { ids.insert(id.to_owned()); }
            }
        } else if let Some(id) = pane.get("session_id").and_then(|v| v.as_str()).filter(|id| !id.is_empty()) { ids.insert(id.to_owned()); }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_are_ordered_and_receipt_precedes_cleanup() {
        let mut transfer = Transfer::new("source".into(), "child".into(), vec![], "receipt".into(), None);
        assert!(transfer.advance(Phase::Received).is_err());
        for phase in [
            Phase::Shown,
            Phase::Committed,
            Phase::Received,
            Phase::Cleaned,
        ] {
            assert_eq!(transfer.advance(phase), Ok(true));
        }
        assert_eq!(transfer.advance(Phase::Cleaned), Ok(false));
    }

    #[test]
    fn failures_at_every_phase_roll_back_once() {
        let phases = [
            Phase::Prepared,
            Phase::Shown,
            Phase::Committed,
            Phase::Received,
            Phase::Cleaned,
        ];
        for phase in phases {
            let mut transfer = Transfer::new("source".into(), "child".into(), vec![], "receipt".into(), None);
            transfer.phase = phase;
            assert_eq!(transfer.advance(Phase::RolledBack), Ok(true));
            assert_eq!(transfer.advance(Phase::RolledBack), Ok(false));
            assert!(transfer.advance(Phase::Committed).is_err());
        }
    }
}

#[cfg(test)]
mod reservation_tests {
    use super::*;
    fn pending() -> Transfer {
        Transfer::new("A".into(), "B".into(), vec![serde_json::json!({"panes":[{"tabs":[{"session_id":"pty-1"}]}]})], "receipt-1".into(), None)
    }
    #[test]
    fn receipt_and_cleanup_do_not_unlock_provisional_window_or_sessions_r2() {
        let mut transfer = pending();
        let onward = vec![serde_json::json!({"panes":[{"tabs":[{"session_id":"pty-1"}]}]})];
        for phase in [Phase::Prepared, Phase::Shown, Phase::Committed, Phase::Received, Phase::Cleaned] {
            if transfer.phase != phase { transfer.advance(phase).unwrap(); }
            assert!(transfer.reserves_window("B")); assert!(transfer.reserves_sessions(&onward));
            assert!(!transfer.can_forget());
        }
        assert!(transfer.check_finalize("B", "receipt-1").is_err());
        assert!(transfer.check_finalize("A", "wrong-receipt").is_err());
        transfer.check_finalize("A", "receipt-1").unwrap(); transfer.finalized = true;
        assert!(!transfer.reserves_window("B")); assert!(!transfer.reserves_sessions(&onward));
        assert!(transfer.can_forget()); assert!(transfer.advance(Phase::RolledBack).is_err());
    }
    #[test]
    fn premature_finalize_and_rollback_have_distinct_reservation_effects_r2() {
        let mut transfer = pending();
        assert!(transfer.check_finalize("A", "receipt-1").is_err()); assert!(transfer.reserved());
        transfer.advance(Phase::RolledBack).unwrap(); assert!(!transfer.reserved()); assert!(transfer.can_forget());
    }
    #[test]
    fn sessions_are_reserved_across_window_labels_and_legacy_pane_configs_r2() {
        let transfer = pending();
        assert!(transfer.reserves_sessions(&[serde_json::json!({"panes":[{"session_id":"pty-1"}]})]));
        assert!(!transfer.reserves_sessions(&[serde_json::json!({"panes":[{"tabs":[{"session_id":"other"}]}]})]));
        assert!(!transfer.reserves_window("C"));
    }
}
