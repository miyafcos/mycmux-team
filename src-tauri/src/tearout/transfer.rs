use serde::{Deserialize, Serialize};

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
    pub receiver: String,
    pub configs: Vec<serde_json::Value>,
    pub phase: Phase,
}

impl Transfer {
    pub fn new(receiver: String, configs: Vec<serde_json::Value>) -> Self {
        Self {
            receiver,
            configs,
            phase: Phase::Prepared,
        }
    }

    /// A repeated rollback cannot revoke a restored session a second time.
    pub fn advance(&mut self, next: Phase) -> Result<bool, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_are_ordered_and_receipt_precedes_cleanup() {
        let mut transfer = Transfer::new("child".into(), vec![]);
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
            let mut transfer = Transfer::new("child".into(), vec![]);
            transfer.phase = phase;
            assert_eq!(transfer.advance(Phase::RolledBack), Ok(true));
            assert_eq!(transfer.advance(Phase::RolledBack), Ok(false));
            assert!(transfer.advance(Phase::Committed).is_err());
        }
    }
}
