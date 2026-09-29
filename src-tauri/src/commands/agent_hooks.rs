use crate::agent_state::settings::AgentHooksStatus;
use crate::agent_state::{self, HookMode, Provider};
use tauri::Manager;

#[tauri::command]
pub async fn agent_hooks_status() -> Result<AgentHooksStatus, String> {
    tauri::async_runtime::spawn_blocking(agent_state::settings::status_default)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn agent_hooks_set(
    app: tauri::AppHandle,
    provider: Provider,
    enabled: bool,
) -> Result<AgentHooksStatus, String> {
    // Serialize the filesystem update and the runtime-mode update together.
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    let result = tauri::async_runtime::spawn_blocking(move || {
        agent_state::settings::set_default(provider, enabled)
    })
    .await
    .map_err(|error| error.to_string())?;
    // Also refresh modes after partial filesystem failures; never keep a stale Installed mode.
    let snapshot = match &result {
        Ok(snapshot) => Some(snapshot.clone()),
        Err(_) => agent_hooks_status().await.ok(),
    };
    if let Some(snapshot) = snapshot {
        let state = app.state::<crate::AppState>();
        for (provider, mode) in snapshot.modes() {
            state.hook_service.set_hook_mode(provider, mode);
        }
    } else {
        app.state::<crate::AppState>()
            .hook_service
            .set_hook_mode(provider, HookMode::Unavailable);
    }
    result
}

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
