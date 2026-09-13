use crate::agent_state::{self, HookMode, Provider};

fn apply_modes(
    service: &agent_state::HookService,
    outcome: &agent_state::settings::HookInstallOutcome,
) {
    for provider in [Provider::Claude, Provider::Codex, Provider::Grok] {
        let mode = outcome
            .modes
            .get(&provider)
            .copied()
            .unwrap_or(HookMode::Unavailable);
        service.set_hook_mode(provider, mode);
    }
}

pub fn install_at_startup(service: &agent_state::HookService) {
    match agent_state::settings::reconcile_default(None) {
        Ok(outcome) => {
            apply_modes(service, &outcome);
            for warning in outcome.warnings {
                crate::diag_warn!("agent_hooks", "{warning}");
            }
        }
        Err(error) => {
            for provider in [Provider::Claude, Provider::Codex, Provider::Grok] {
                service.set_hook_mode(provider, HookMode::Unavailable);
            }
            crate::diag_warn!("agent_hooks", "startup reconciliation failed: {error}");
        }
    }
}
