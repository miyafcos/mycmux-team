use tauri::AppHandle;

use crate::commands::terminal::can_restore_agent_session;
use crate::db::storage::{self, PaneConfig, PaneTabConfig, PersistentData, PersistentDataEnvelope};

#[tauri::command(async)]
pub async fn load_persistent_data(app_handle: AppHandle) -> Result<PersistentDataEnvelope, String> {
    crate::util::task::run_blocking("load_persistent_data", move || {
        load_persistent_data_for(&app_handle)
    }).await
}

fn load_persistent_data_for<T: storage::PersistentDataTarget + ?Sized>(
    target: &T,
) -> Result<PersistentDataEnvelope, String> {
    crate::perf_timeline::mark("store.load.enter", None);
    let mut envelope = storage::load_envelope(target)?;
    crate::perf_timeline::mark("store.load.read", None);
    if let Some(data) = envelope.data.as_mut() {
        sanitize_agent_sessions(data);
    }
    crate::perf_timeline::mark("store.load.sanitized", None);
    Ok(envelope)
}

#[tauri::command(async)]
pub async fn save_persistent_data(
    app_handle: AppHandle,
    mut data: PersistentData,
) -> Result<(), storage::PersistentStorageError> {
    crate::util::task::run_blocking_result("save_persistent_data", move || {
        crate::perf_timeline::mark("store.save.enter", None);
        attach_detached_window_frames(&app_handle, &mut data);
        let live = live_workspace_ids(&app_handle);
        let result = save_persistent_data_for(&app_handle, data, &live);
        crate::perf_timeline::mark("store.save.done", None);
        result
    }).await
}

/// The registry is the authority for ownership, including normal child
/// windows and workspaces currently waiting for adoption. Read each native
/// frame once, outside the storage lock, and keep the legacy outer frame too.
fn attach_detached_window_frames(app_handle: &AppHandle, data: &mut PersistentData) {
    use tauri::Manager;
    let Some(state) = app_handle.try_state::<crate::AppState>() else { return; };
    let mut groups = std::collections::HashMap::new();
    let mut outer_frames = std::collections::HashMap::new();
    for label in state.window_registry.known_windows() {
        let selection = state.window_registry.fragment(&label);
        let mut group = storage::WindowGroupConfig {
            label: label.clone(), frame: None, decorated: None,
            native_tearout: selection.as_ref().and_then(|fragment| fragment.workspaces.iter()
                .find_map(|workspace| workspace["window_native_tearout"].as_bool())),
            active_workspace_id: selection.as_ref().and_then(|row| row.active_workspace_id.clone()),
            active_pane_id: selection.as_ref().and_then(|row| row.active_pane_id.clone()),
            active_tab_id: selection.as_ref().and_then(|row| row.active_tab_id.clone()),
        };
        if let Some(window) = app_handle.get_window(&label) {
            group.decorated = window.is_decorated().ok();
            if let (Ok(scale), Ok(position), Ok(inner), Ok(outer)) = (
                window.scale_factor(), window.outer_position(), window.inner_size(), window.outer_size(),
            ) {
                let position = position.to_logical::<f64>(scale);
                let inner = inner.to_logical::<f64>(scale);
                let outer = outer.to_logical::<f64>(scale);
                group.frame = Some(storage::WindowFrameConfig {
                    x: position.x, y: position.y, width: inner.width, height: inner.height,
                });
                outer_frames.insert(label.clone(), storage::WindowFrameConfig {
                    x: position.x, y: position.y, width: outer.width, height: outer.height,
                });
            }
        }
        groups.insert(label, group);
    }
    apply_saved_window_groups(data, &state.window_registry, &groups, &outer_frames);
}

fn apply_saved_window_groups(
    data: &mut PersistentData,
    registry: &crate::window_registry::WindowRegistry,
    groups: &std::collections::HashMap<String, storage::WindowGroupConfig>,
    outer_frames: &std::collections::HashMap<String, storage::WindowFrameConfig>,
) {
    for workspace in &mut data.workspaces {
        let Some(label) = registry.window_for_workspace(&workspace.id) else { continue; };
        if let Some(group) = groups.get(&label) {
            workspace.window_group = Some(group.clone());
        }
        workspace.window_frame = if label == crate::window_registry::MAIN_WINDOW_LABEL {
            None
        } else {
            outer_frames.get(&label).cloned().or_else(|| workspace.window_frame.clone())
        };
    }
}

/// Workspaces some live window still holds: its own published list, plus the
/// queues of workspaces handed to a window that has not adopted them yet.
fn live_workspace_ids(app_handle: &AppHandle) -> std::collections::HashSet<String> {
    use tauri::Manager;

    let Some(state) = app_handle.try_state::<crate::AppState>() else {
        return std::collections::HashSet::new();
    };
    state.window_registry.held_workspace_ids()
}

fn save_persistent_data_for<T: storage::PersistentDataTarget + ?Sized>(
    target: &T,
    mut data: PersistentData,
    live_workspace_ids: &std::collections::HashSet<String>,
) -> Result<(), storage::PersistentStorageError> {
    data.schema_version = storage::CURRENT_SCHEMA_VERSION;
    let live = live_workspace_ids.clone();
    storage::update(target, move |disk| merge_persistent_data(disk, data, &live))
}

/// Workspaces the save left out, although a live window still holds them.
///
/// Every window writes the whole file, and what it writes is its own
/// workspaces plus the fragments its peers published. A peer that has not
/// published yet — mid tear-out, mid handover, or one whose leadership was
/// just handed over — is therefore invisible to the writer, and a straight
/// assignment would drop its workspaces (and its saved sessions) from the
/// file. Carrying those entries over from disk keeps a save additive for
/// anything still on screen somewhere; a workspace nobody holds any more (the
/// user closed it, or closed the window that held it) is absent from the
/// registry too, so it still leaves the file.
fn carry_over_live_workspaces(
    disk: &[storage::WorkspaceConfig],
    saved: &[storage::WorkspaceConfig],
    live: &std::collections::HashSet<String>,
) -> Vec<storage::WorkspaceConfig> {
    let written: std::collections::HashSet<&str> =
        saved.iter().map(|workspace| workspace.id.as_str()).collect();
    disk.iter()
        .filter(|workspace| !written.contains(workspace.id.as_str()))
        .filter(|workspace| live.contains(&workspace.id))
        .cloned()
        .collect()
}

fn merge_persistent_data(
    disk: &mut PersistentData,
    data: PersistentData,
    live: &std::collections::HashSet<String>,
) {
    disk.schema_version = data.schema_version;
    let mut workspaces = data.workspaces;
    let carried = carry_over_live_workspaces(&disk.workspaces, &workspaces, live);
    if !carried.is_empty() {
        crate::diag::log(&format!(
            "[persist] kept {} workspace(s) a live window still holds but this save left out",
            carried.len()
        ));
        workspaces.extend(carried);
    }
    disk.workspaces = workspaces;
    // These settings have no frontend store or setter, so the frontend's
    // persistence payload omits them; preserve their Rust-owned values.
    let dirty_save_mode = disk.settings.dirty_save_mode;
    let osc7_tracking_enabled = disk.settings.osc7_tracking_enabled;
    // Frontend settings payload has no store for this; dedicated ailog
    // get/set commands own it. Preserve across workspace saves.
    let ailog_usd_jpy_rate = disk.settings.ailog_usd_jpy_rate;
    let ailog_mirror_full_text_root = disk.settings.ailog_mirror_full_text_root.clone();
    disk.settings = data.settings;
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
    use std::collections::HashSet;

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
            let error = save_persistent_data_for(path.as_path(), PersistentData::default(), &HashSet::new())
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
                    save_persistent_data_for(clean_path.as_path(), PersistentData::default(), &HashSet::new())
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
            session_id: None,
            agent_id: "codex".to_string(),
            label: Some("Codex".to_string()),
            label_source: None,
            display_name: None,
            display_name_source: None,
            r#type: None,
            preset_id: None,
            html_path: None,
            source_path: None,
            source_kind: None,
            preview_path: None,
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

    fn workspace_config(id: &str) -> storage::WorkspaceConfig {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "grid_template_id": "1x1",
            "panes": [],
            "created_at": 0,
        }))
        .expect("workspace config fixture")
    }

    #[test]
    fn saved_groups_follow_real_registry_ownership_and_include_normal_children() {
        use crate::window_registry::{WindowFragment, WindowRegistry};
        let registry = WindowRegistry::new();
        let mut data = PersistentData::default();
        data.workspaces = vec![workspace_config("main-ws"), workspace_config("a"), workspace_config("b")];
        for (label, ids) in [("main", vec!["main-ws"]), ("mycmux-w2", vec!["a", "b"])] {
            registry.publish_fragment(WindowFragment {
                window_label: label.into(),
                workspaces: ids.iter().map(|id| serde_json::to_value(workspace_config(id)).unwrap()).collect(),
                ..Default::default()
            });
        }
        let inner = storage::WindowFrameConfig { x: 120.0, y: 140.0, width: 800.0, height: 600.0 };
        let outer = storage::WindowFrameConfig { height: 628.0, ..inner.clone() };
        let groups = HashMap::from([
            ("main".into(), storage::WindowGroupConfig { label: "main".into(), frame: None, decorated: Some(true), native_tearout: Some(false),
                active_workspace_id: Some("main-ws".into()), active_pane_id: None, active_tab_id: None }),
            ("mycmux-w2".into(), storage::WindowGroupConfig { label: "mycmux-w2".into(), frame: Some(inner.clone()), decorated: Some(false), native_tearout: Some(true),
                active_workspace_id: Some("b".into()), active_pane_id: Some("b-pane".into()), active_tab_id: Some("b-tab".into()) }),
        ]);
        let frames = HashMap::from([("mycmux-w2".into(), outer.clone())]);
        apply_saved_window_groups(&mut data, &registry, &groups, &frames);
        let first = serde_json::to_value(&data).unwrap();
        for _ in 0..6 { apply_saved_window_groups(&mut data, &registry, &groups, &frames); }
        assert_eq!(serde_json::to_value(&data).unwrap(), first);
        assert!(data.workspaces[0].window_frame.is_none());
        for workspace in &data.workspaces[1..] {
            let group = workspace.window_group.as_ref().unwrap();
            assert_eq!(group.label, "mycmux-w2");
            assert_eq!(group.active_workspace_id.as_deref(), Some("b"));
            assert_eq!(group.frame.as_ref(), Some(&inner));
            assert_eq!(workspace.window_frame.as_ref(), Some(&outer));
            assert_ne!(workspace.detached, Some(true));
        }
        registry.queue_adoption("main", vec![serde_json::to_value(workspace_config("a")).unwrap()]);
        apply_saved_window_groups(&mut data, &registry, &groups, &frames);
        assert_eq!(data.workspaces[1].window_group.as_ref().unwrap().label, "main");
        assert!(data.workspaces[1].window_frame.is_none());
    }

    #[test]
    fn saved_window_groups_survive_six_real_save_load_cycles_in_schema_one() {
        let _serial = storage::persistence_test_lock();
        storage::reset_quarantined_schema_for_test();
        let _reset = SchemaLatchReset;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("data.json");
        let mut data = PersistentData::default();
        data.workspaces = vec![serde_json::from_value(serde_json::json!({
            "id":"child","name":"Child","grid_template_id":"1x1","panes":[],"created_at":1,
            "window_group":{"label":"mycmux-w2","frame":{"x":-1000.0,"y":80.0,"width":800.0,"height":600.0},"active_workspace_id":"child"}
        })).unwrap()];
        save_persistent_data_for(path.as_path(), data, &HashSet::new()).unwrap();
        let first = std::fs::read(&path).unwrap();
        for _ in 0..6 {
            let envelope = load_persistent_data_for(path.as_path()).unwrap();
            assert_eq!(envelope.schema_version, 1);
            let data = envelope.data.unwrap();
            assert_eq!(data.workspaces[0].window_group.as_ref().unwrap().label, "mycmux-w2");
            save_persistent_data_for(path.as_path(), data, &HashSet::new()).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), first);
        }
    }

    #[test]
    fn a_save_cannot_drop_a_workspace_another_window_still_holds() {
        // What a leadership handover used to do: the window that took over
        // wrote only its own workspace, and the other window's disappeared
        // from data.json with every session saved in it.
        let mut disk = PersistentData::default();
        disk.workspaces = vec![workspace_config("main-ws"), workspace_config("child-ws")];
        let mut incoming = PersistentData::default();
        incoming.workspaces = vec![workspace_config("child-ws")];
        let live = HashSet::from(["main-ws".to_string(), "child-ws".to_string()]);

        merge_persistent_data(&mut disk, incoming, &live);

        let ids: Vec<&str> = disk.workspaces.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["child-ws", "main-ws"]);
    }

    #[test]
    fn a_closed_workspace_still_leaves_the_file() {
        // Nothing holds it any more, so the guard must not resurrect it.
        let mut disk = PersistentData::default();
        disk.workspaces = vec![workspace_config("kept"), workspace_config("closed")];
        let mut incoming = PersistentData::default();
        incoming.workspaces = vec![workspace_config("kept")];
        let live = HashSet::from(["kept".to_string()]);

        merge_persistent_data(&mut disk, incoming, &live);

        let ids: Vec<&str> = disk.workspaces.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["kept"]);
    }

    #[test]
    fn merge_persistent_data_preserves_rust_owned_settings() {
        let mut disk = PersistentData::default();
        disk.settings.dirty_save_mode = true;
        disk.settings.osc7_tracking_enabled = false;
        disk.settings.ailog_usd_jpy_rate = 155.0;
        disk.settings.ailog_mirror_full_text_root = Some("X:\\archive".to_string());
        let mut incoming = PersistentData::default();
        incoming.settings.dirty_save_mode = false;
        incoming.settings.osc7_tracking_enabled = true;
        incoming.settings.ailog_usd_jpy_rate = 150.0;
        incoming.settings.ailog_mirror_full_text_root = None;
        incoming.settings.font_size = 19;

        merge_persistent_data(&mut disk, incoming, &HashSet::new());

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
