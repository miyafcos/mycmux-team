use tauri::AppHandle;

use crate::commands::terminal::can_restore_agent_session;
use crate::db::storage::{self, PaneConfig, PaneTabConfig, PersistentData, PersistentDataEnvelope};

#[tauri::command(async)]
pub fn load_persistent_data(app_handle: AppHandle) -> Result<PersistentDataEnvelope, String> {
    load_persistent_data_for(&app_handle)
}

fn load_persistent_data_for<T: storage::PersistentDataTarget + ?Sized>(
    target: &T,
) -> Result<PersistentDataEnvelope, String> {
    let mut envelope = storage::load_envelope(target)?;
    if let Some(data) = envelope.data.as_mut() {
        sanitize_agent_sessions(data);
    }
    Ok(envelope)
}

#[tauri::command(async)]
pub fn save_persistent_data(
    app_handle: AppHandle,
    data: PersistentData,
) -> Result<(), storage::PersistentStorageError> {
    save_persistent_data_for(&app_handle, data)
}

fn save_persistent_data_for<T: storage::PersistentDataTarget + ?Sized>(
    target: &T,
    mut data: PersistentData,
) -> Result<(), storage::PersistentStorageError> {
    data.schema_version = storage::CURRENT_SCHEMA_VERSION;
    storage::update(target, move |disk| merge_persistent_data(disk, data))
}

fn merge_persistent_data(disk: &mut PersistentData, data: PersistentData) {
    disk.schema_version = data.schema_version;
    disk.workspaces = data.workspaces;
    // These settings have no frontend store or setter, so the frontend's
    // persistence payload omits them; preserve their Rust-owned values.
    let remote_bind_all = disk.settings.remote_bind_all;
    let remote_enabled = disk.settings.remote_enabled;
    let dirty_save_mode = disk.settings.dirty_save_mode;
    let osc7_tracking_enabled = disk.settings.osc7_tracking_enabled;
    // Frontend settings payload has no store for this; dedicated ailog
    // get/set commands own it. Preserve across workspace saves.
    let ailog_usd_jpy_rate = disk.settings.ailog_usd_jpy_rate;
    let ailog_mirror_full_text_root = disk.settings.ailog_mirror_full_text_root.clone();
    disk.settings = data.settings;
    disk.settings.remote_bind_all = remote_bind_all;
    disk.settings.remote_enabled = remote_enabled;
    disk.settings.dirty_save_mode = dirty_save_mode;
    disk.settings.osc7_tracking_enabled = osc7_tracking_enabled;
    disk.settings.ailog_usd_jpy_rate = ailog_usd_jpy_rate;
    disk.settings.ailog_mirror_full_text_root = ailog_mirror_full_text_root;
    disk.active_workspace_id = data.active_workspace_id;
    disk.active_pane_id = data.active_pane_id;
    disk.active_tab_id = data.active_tab_id;
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
        "grok" => Some("grok".to_string()),
        _ => None,
    }
}

fn agent_id_for_kind(kind: Option<&str>) -> Option<&'static str> {
    match kind {
        Some("claude") => Some("claude-code"),
        Some("codex") => Some("codex"),
        Some("grok") => Some("grok"),
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

    struct SchemaLatchReset;

    impl Drop for SchemaLatchReset {
        fn drop(&mut self) {
            storage::reset_quarantined_schema_for_test();
        }
    }

    #[cfg(windows)]
    #[test]
    fn command_save_lifecycle_preserves_future_schema_bytes() {
        use sha2::{Digest, Sha256};

        let _serial = storage::persistence_test_lock();
        storage::reset_quarantined_schema_for_test();
        let _reset = SchemaLatchReset;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let original = include_bytes!("../../../tests/fixtures/data_json_schema_999_canary.json");
        std::fs::write(&path, original).unwrap();
        let original_hash = Sha256::digest(original);

        let envelope = load_persistent_data_for(path.as_path()).unwrap();
        assert!(!envelope.supported);
        assert_eq!(envelope.schema_version, 999);
        // Exercise both production rejection layers in one lifecycle: the
        // first save rediscovers the late-swapped file in storage::update;
        // the later saves are stopped by the process latch it sets.
        storage::reset_quarantined_schema_for_test();
        for (index, phase) in ["debounced autosave", "shutdown flush", "retry"]
            .into_iter()
            .enumerate()
        {
            let error = save_persistent_data_for(path.as_path(), PersistentData::default())
                .expect_err(phase);
            assert_eq!(error.kind(), "unsupportedSchema", "{phase}");
            assert_eq!(error.schema_version(), Some(999), "{phase}");
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!(bytes.as_slice(), original, "{phase}");
            assert_eq!(Sha256::digest(&bytes), original_hash, "{phase}");
            let names = std::fs::read_dir(temp.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>();
            assert_eq!(
                names,
                vec![std::ffi::OsString::from("data.json")],
                "{phase}"
            );
            if index == 0 {
                let clean_path = temp.path().join("clean-target.json");
                let latched_error =
                    save_persistent_data_for(clean_path.as_path(), PersistentData::default())
                        .expect_err("process latch must reject a different clean target");
                assert_eq!(latched_error.kind(), "unsupportedSchema");
                assert_eq!(latched_error.schema_version(), Some(999));
                assert!(!clean_path.exists());
            }
        }
    }

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
            suppressed_agent_sessions: None,
            launch_env: Some(HashMap::from([(
                "MYCMUX_RESUME".to_string(),
                "missing-session".to_string(),
            )])),
            active_tab_id: None,
            pinned_tab_id: None,
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
            label_source: None,
            r#type: None,
            preset_id: None,
            cwd: None,
            last_process: None,
            claude_session_id: None,
            agent_kind: Some("codex".to_string()),
            agent_session_id: Some("tab-session".to_string()),
            suppressed_agent_sessions: None,
            launch_env: Some(HashMap::from([(
                "MYCMUX_RESUME".to_string(),
                "tab-session".to_string(),
            )])),
            terminal_snapshot: None,
            turn_marks: None,
            lifecycle: None,
            origin: None,
            declared_prompt: None,
            declared_target: None,
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

    #[test]
    fn merge_persistent_data_preserves_rust_owned_settings() {
        let mut disk = PersistentData::default();
        disk.settings.remote_bind_all = true;
        disk.settings.dirty_save_mode = true;
        disk.settings.osc7_tracking_enabled = false;
        disk.settings.ailog_usd_jpy_rate = 155.0;
        disk.settings.ailog_mirror_full_text_root = Some("X:\\archive".to_string());
        let mut incoming = PersistentData::default();
        incoming.settings.remote_bind_all = false;
        incoming.settings.dirty_save_mode = false;
        incoming.settings.osc7_tracking_enabled = true;
        incoming.settings.ailog_usd_jpy_rate = 150.0;
        incoming.settings.ailog_mirror_full_text_root = None;
        incoming.settings.font_size = 19;

        merge_persistent_data(&mut disk, incoming);

        assert!(disk.settings.remote_bind_all);
        assert!(disk.settings.dirty_save_mode);
        assert!(!disk.settings.osc7_tracking_enabled);
        assert_eq!(disk.settings.ailog_usd_jpy_rate, 155.0);
        assert_eq!(
            disk.settings.ailog_mirror_full_text_root.as_deref(),
            Some("X:\\archive")
        );
        assert_eq!(disk.settings.font_size, 19);
    }
}
