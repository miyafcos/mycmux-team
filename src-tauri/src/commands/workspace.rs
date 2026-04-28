use tauri::AppHandle;

use crate::commands::terminal::can_restore_agent_session;
use crate::db::storage::{
    self, AppSettings, PaneConfig, PaneTabConfig, PersistentData, WorkspaceConfig,
};

#[tauri::command]
pub fn load_persistent_data(app_handle: AppHandle) -> Result<PersistentData, String> {
    let mut data = storage::load(&app_handle)?;
    sanitize_agent_sessions(&mut data);
    Ok(data)
}

#[tauri::command]
pub fn save_persistent_data(app_handle: AppHandle, mut data: PersistentData) -> Result<(), String> {
    data.schema_version = 1;
    storage::save(&app_handle, &data)
}

#[tauri::command]
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

#[tauri::command]
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

fn clear_unrestorable_tab(tab: &mut PaneTabConfig, kind: &str, session_id: &str) {
    tab.agent_id = "shell-starter".to_string();
    tab.claude_session_id = None;
    tab.agent_kind = None;
    tab.agent_session_id = None;
    tab.terminal_snapshot = Some(vec![
        format!(
            "Resume unavailable: {kind} session {session_id} was not found for this workspace."
        ),
        "Use the launcher to start a new session or choose resume manually.".to_string(),
    ]);
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
        return;
    }
    clear_unrestorable_tab(tab, &kind, &session_id);
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
        return;
    }
    pane.agent_id = "shell-starter".to_string();
    pane.claude_session_id = None;
    pane.agent_kind = None;
    pane.agent_session_id = None;
}

fn sanitize_agent_sessions(data: &mut PersistentData) {
    for workspace in &mut data.workspaces {
        for pane in &mut workspace.panes {
            sanitize_pane_agent_sessions(pane);
        }
    }
}
