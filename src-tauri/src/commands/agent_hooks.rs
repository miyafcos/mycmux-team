use crate::agent_state::{self, HookMode, Provider};
use crate::AppState;

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

#[tauri::command(async)]
pub async fn agent_hooks_set_enabled(
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let service = state.hook_service.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        agent_state::settings::reconcile_default(Some(enabled))
    })
    .await
    .map_err(|error| error.to_string())??;
    apply_modes(&service, &outcome);
    if !enabled {
        service.revoke_all();
    }
    for warning in outcome.warnings {
        crate::diag_warn!("agent_hooks", "{warning}");
    }
    Ok(outcome.enabled)
}
