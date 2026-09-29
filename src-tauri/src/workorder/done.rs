//! Pure, machine-only completion decision.

use serde::{Deserialize, Serialize};

use super::{GateId, GateStatus, ReportOutcome, WorkItemId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequiredGateStatus {
    pub gate_id: GateId,
    pub status: GateStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequiredItemStatus {
    pub work_item_id: WorkItemId,
    pub terminal_report_received: bool,
    pub outcome: Option<ReportOutcome>,
    pub gates: Vec<RequiredGateStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoneInputs {
    pub required_items: Vec<RequiredItemStatus>,
    pub integrator_report_received: bool,
    pub open_decision_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DoneBlocker {
    RequiredItemMissingSucceededTerminalReport {
        work_item_id: WorkItemId,
    },
    RequiredItemGateNotPassed {
        work_item_id: WorkItemId,
        gate_id: GateId,
        status: GateStatus,
    },
    IntegratorReportMissing,
    OpenDecisions {
        count: u32,
    },
}

pub fn is_done(inputs: &DoneInputs) -> bool {
    done_blockers(inputs).is_empty()
}

pub fn done_blockers(inputs: &DoneInputs) -> Vec<DoneBlocker> {
    let mut blockers = Vec::new();
    for item in &inputs.required_items {
        if !item.terminal_report_received || item.outcome != Some(ReportOutcome::Succeeded) {
            blockers.push(DoneBlocker::RequiredItemMissingSucceededTerminalReport {
                work_item_id: item.work_item_id.clone(),
            });
        }
        for gate in &item.gates {
            if gate.status != GateStatus::Pass {
                blockers.push(DoneBlocker::RequiredItemGateNotPassed {
                    work_item_id: item.work_item_id.clone(),
                    gate_id: gate.gate_id.clone(),
                    status: gate.status,
                });
            }
        }
    }
    if !inputs.integrator_report_received {
        blockers.push(DoneBlocker::IntegratorReportMissing);
    }
    if inputs.open_decision_count != 0 {
        blockers.push(DoneBlocker::OpenDecisions {
            count: inputs.open_decision_count,
        });
    }
    blockers
}
