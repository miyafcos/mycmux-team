use tauri::AppHandle;

use crate::commands::terminal::can_restore_agent_session;
use crate::db::storage::{
    self, AppSettings, PaneConfig, PaneTabConfig, PersistentData, WorkspaceConfig,
};

#[tauri::command(async)]
pub fn load_persistent_data(app_handle: AppHandle) -> Result<PersistentData, String> {
    let mut data = storage::load(&app_handle)?;
    sanitize_agent_sessions(&mut data);
    Ok(data)
}

#[tauri::command(async)]
pub fn save_persistent_data(app_handle: AppHandle, mut data: PersistentData) -> Result<(), String> {
    data.schema_version = 1;
    storage::save(&app_handle, &data)
}

#[tauri::command(async)]
pub fn save_workspaces(
    app_handle: AppHandle,
    workspaces: Vec<WorkspaceConfig>,
    active_workspace_id: Option<String>,
    active_pane_id: Option<String>,
) -> Result<(), String> {
    storage::update(&app_handle, |data| {
        data.schema_version = 1;
        data.workspaces = workspaces;
        data.active_workspace_id = active_workspace_id;
        data.active_pane_id = active_pane_id;
        data.active_tab_id = None;
    })
}

#[tauri::command(async)]
pub fn save_settings(app_handle: AppHandle, settings: AppSettings) -> Result<(), String> {
    storage::update(&app_handle, |data| {
        data.schema_version = 1;
        data.settings = settings;
    })
}

fn infer_agent_kind(
    agent_id: &str,
    agent_kind: Option<&str>,
    claude_session_id: Option<&str>,
) -> Option<String> {
    if let Some(kind) = agent_kind {
        return Some(kind.to_string());
    }
    if claude_session_id.is_some() {
        return Some("claude".to_string());
    }
    match agent_id {
        "claude-code" => Some("claude".to_string()),
        "codex" => Some("codex".to_string()),
        _ => None,
    }
}

fn agent_id_for_kind(kind: Option<&str>) -> Option<&'static str> {
    match kind {
        Some("claude") => Some("claude-code"),
        Some("codex") => Some("codex"),
        Some("claude-codex") => Some("shell-starter"),
        _ => None,
    }
}

fn sanitize_tab_agent_session(tab: &mut PaneTabConfig, pane_cwd: Option<&str>) {
    let kind = infer_agent_kind(
        &tab.agent_id,
        tab.agent_kind.as_deref(),
        tab.claude_session_id.as_deref(),
    );
    let session_id = tab
        .agent_session_id
        .as_deref()
        .or(tab.claude_session_id.as_deref())
        .map(|value| value.to_string());
    let (Some(kind), Some(session_id)) = (kind, session_id) else {
        return;
    };
    let cwd = tab.cwd.as_deref().or(pane_cwd);
    if can_restore_agent_session(&kind, &session_id, cwd) {
        if let Some(agent_id) = agent_id_for_kind(Some(kind.as_str())) {
            tab.agent_id = agent_id.to_string();
        }
        tab.agent_kind = Some(kind);
        tab.agent_session_id = Some(session_id);
    }
    // Keep persisted resume identity intact when the local session index is
    // temporarily stale or unavailable. The renderer can still decide how to
    // recover, but load must not rewrite the saved session into a shell pane.
}

fn sync_pane_from_active_tab(pane: &mut PaneConfig) {
    let Some(tabs) = pane.tabs.as_ref() else {
        return;
    };
    let active_tab_id = pane.active_tab_id.as_deref();
    let active = tabs
        .iter()
        .find(|tab| tab.tab_id.as_deref() == active_tab_id)
        .or_else(|| tabs.first());
    let Some(active) = active else {
        return;
    };
    pane.agent_id = active.agent_id.clone();
    pane.claude_session_id = active.claude_session_id.clone();
    pane.agent_kind = active.agent_kind.clone();
    pane.agent_session_id = active.agent_session_id.clone();
    pane.launch_env = active.launch_env.clone();
}

fn sanitize_pane_agent_sessions(pane: &mut PaneConfig) {
    let pane_cwd = pane.cwd.clone();
    if let Some(tabs) = pane.tabs.as_mut() {
        for tab in tabs {
            sanitize_tab_agent_session(tab, pane_cwd.as_deref());
        }
        sync_pane_from_active_tab(pane);
        return;
    }

    let kind = infer_agent_kind(
        &pane.agent_id,
        pane.agent_kind.as_deref(),
        pane.claude_session_id.as_deref(),
    );
    let session_id = pane
        .agent_session_id
        .as_deref()
        .or(pane.claude_session_id.as_deref());
    let (Some(kind), Some(session_id)) = (kind, session_id) else {
        return;
    };
    if can_restore_agent_session(&kind, session_id, pane.cwd.as_deref()) {
        if let Some(agent_id) = agent_id_for_kind(Some(kind.as_str())) {
            pane.agent_id = agent_id.to_string();
        }
        pane.agent_kind = Some(kind);
        pane.agent_session_id = Some(session_id.to_string());
    }
}

fn sanitize_agent_sessions(data: &mut PersistentData) {
    for workspace in &mut data.workspaces {
        for pane in &mut workspace.panes {
            sanitize_pane_agent_sessions(pane);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn pane_with_session() -> PaneConfig {
        PaneConfig {
            pane_id: Some("pane-1".to_string()),
            agent_id: "codex".to_string(),
            label: Some("Codex".to_string()),
            cwd: Some("C:\\missing\\workspace".to_string()),
            last_process: None,
            claude_session_id: None,
            agent_kind: Some("codex".to_string()),
            agent_session_id: Some("missing-session".to_string()),
            launch_env: Some(HashMap::from([(
                "MYCMUX_RESUME".to_string(),
                "missing-session".to_string(),
            )])),
            active_tab_id: None,
            tabs: None,
        }
    }

    #[test]
    fn sanitize_pane_agent_sessions_keeps_unrestorable_session_identity() {
        let mut pane = pane_with_session();

        sanitize_pane_agent_sessions(&mut pane);

        assert_eq!(pane.agent_id, "codex");
        assert_eq!(pane.agent_kind.as_deref(), Some("codex"));
        assert_eq!(pane.agent_session_id.as_deref(), Some("missing-session"));
        assert_eq!(
            pane.launch_env
                .as_ref()
                .and_then(|launch_env| launch_env.get("MYCMUX_RESUME"))
                .map(String::as_str),
            Some("missing-session")
        );
    }

    #[test]
    fn sync_pane_from_active_tab_preserves_launch_env() {
        let mut pane = pane_with_session();
        pane.active_tab_id = Some("tab-1".to_string());
        pane.tabs = Some(vec![PaneTabConfig {
            tab_id: Some("tab-1".to_string()),
            agent_id: "codex".to_string(),
            label: Some("Codex".to_string()),
            r#type: None,
            cwd: None,
            last_process: None,
            claude_session_id: None,
            agent_kind: Some("codex".to_string()),
            agent_session_id: Some("tab-session".to_string()),
            launch_env: Some(HashMap::from([(
                "MYCMUX_RESUME".to_string(),
                "tab-session".to_string(),
            )])),
            terminal_snapshot: None,
        }]);

        sync_pane_from_active_tab(&mut pane);

        assert_eq!(pane.agent_session_id.as_deref(), Some("tab-session"));
        assert_eq!(
            pane.launch_env
                .as_ref()
                .and_then(|launch_env| launch_env.get("MYCMUX_RESUME"))
                .map(String::as_str),
            Some("tab-session")
        );
    }
}
