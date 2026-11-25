use tauri::{AppHandle, Manager};

use crate::commands::terminal::can_restore_agent_session;
use crate::db::storage::{self, PaneConfig, PaneTabConfig, PersistentData, PersistentDataEnvelope};
use crate::window_registry::{WindowRegistry, MAIN_WINDOW_LABEL};

#[tauri::command(async)]
pub async fn load_persistent_data(app_handle: AppHandle) -> Result<PersistentDataEnvelope, String> {
    crate::util::task::run_blocking("load_persistent_data", move || {
        let state = app_handle.try_state::<crate::AppState>();
        let result = load_persistent_data_for(&app_handle, state.as_ref().map(|state| &state.window_registry));
        match &result {
            Ok(envelope) => {
                if let Some(data) = &envelope.data {
                    let counts = data.layout_counts();
                    crate::diag::log(&format!(
                        "[persist] startup load workspaces={} tabs={} pid={}",
                        counts.workspaces, counts.tabs, std::process::id()
                    ));
                } else {
                    crate::diag_warn!("persist", "startup load rejected schema {}", envelope.schema_version);
                }
            }
            Err(error) => crate::diag_warn!("persist", "startup load failed: {error}"),
        }
        result
    }).await
}

fn load_persistent_data_for<T: storage::PersistentDataTarget + ?Sized>(
    target: &T,
    registry: Option<&WindowRegistry>,
) -> Result<PersistentDataEnvelope, String> {
    crate::perf_timeline::mark("store.load.enter", None);
    let mut envelope = storage::load_envelope(target)?;
    crate::perf_timeline::mark("store.load.read", None);
    if let Some(data) = envelope.data.as_mut() {
        if let Some(registry) = registry {
            hold_loaded_workspaces(registry, data);
        }
        sanitize_agent_sessions(data);
    }
    crate::perf_timeline::mark("store.load.sanitized", None);
    Ok(envelope)
}

fn hold_loaded_workspaces(registry: &WindowRegistry, data: &PersistentData) {
    registry.hold_startup_workspaces(data.workspaces.iter().map(|workspace| {
        let label = workspace.window_group.as_ref()
            .map(|group| group.label.as_str())
            .filter(|label| crate::commands::window::is_valid_child_window_label(label))
            .unwrap_or(MAIN_WINDOW_LABEL);
        (workspace.id.as_str(), has_restorable_panes(workspace).then_some(label))
    }));
}

fn has_restorable_panes(workspace: &storage::WorkspaceConfig) -> bool {
    workspace.panes.iter().any(|pane| pane.tabs.as_ref().is_none_or(|tabs| {
        tabs.iter().any(|tab| matches!(tab.lifecycle.as_deref(), None | Some("declared")))
    }))
}

#[tauri::command(async)]
pub async fn save_persistent_data(
    _trusted: crate::ipc_caller::TrustedAppCaller,
    app_handle: AppHandle,
    window: tauri::Window,
    mut data: PersistentData,
    selection_changed: Option<bool>,
) -> Result<(), storage::PersistentStorageError> {
    let writer = window.label().to_owned();
    crate::util::task::run_blocking_result("save_persistent_data", move || {
        crate::perf_timeline::mark("store.save.enter", None);
        attach_detached_window_frames(&app_handle, &mut data);
        let state = app_handle.try_state::<crate::AppState>();
        if let Some(state) = &state {
            canonicalize_live_agent_sessions(&mut data, |session| {
                state.session_manager.trusted_agent_identity(session)
                    .map(|identity| (identity.kind, identity.session_id))
                    .or_else(|| state.session_manager.requested_conversation(session))
            });
        }
        let result = save_persistent_data_for(
            &app_handle, data, state.as_ref().map(|state| &state.window_registry), Some(&writer),
            selection_changed.unwrap_or(false),
        );
        crate::perf_timeline::mark("store.save.done", None);
        result
    }).await
}

/// The registry is the authority for ownership, including normal child
/// windows and workspaces currently waiting for adoption. Read each native
/// frame once, outside the storage lock, and keep the legacy outer frame too.
fn attach_detached_window_frames(app_handle: &AppHandle, data: &mut PersistentData) {
    let Some(state) = app_handle.try_state::<crate::AppState>() else { return; };
    let mut groups = std::collections::HashMap::new();
    let mut outer_frames = std::collections::HashMap::new();
    for label in state.window_registry.known_windows() {
        let selection = state.window_registry.fragment(&label);
        // A queued startup config already has the group's last frame and
        // selection. Keep them until the receiver publishes its live view.
        if selection.is_none() {
            if let Some(saved) = data.workspaces.iter().filter_map(|workspace| {
                workspace.window_group.as_ref()
            }).find(|group| group.label == label) {
                groups.insert(label, saved.clone());
                continue;
            }
        }
        let mut group = storage::WindowGroupConfig {
            label: label.clone(), frame: None, decorated: None, maximized: None,
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
            #[cfg(target_os = "windows")]
            if group.native_tearout == Some(true) {
                if let Ok((inner, outer, true)) = crate::tearout::saved_native_frame(&window) {
                    group.maximized = Some(true);
                    group.frame = Some(inner);
                    outer_frames.insert(label.clone(), outer);
                }
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

fn save_persistent_data_for<T: storage::PersistentDataTarget + ?Sized>(
    target: &T,
    mut data: PersistentData,
    registry: Option<&WindowRegistry>,
    writer: Option<&str>,
    selection_changed: bool,
) -> Result<(), storage::PersistentStorageError> {
    data.schema_version = storage::CURRENT_SCHEMA_VERSION;
    storage::update_reporting_layout(
        target,
        move |disk| {
            let live = registry.map(WindowRegistry::workspace_ids_for_save).unwrap_or_default();
            merge_persistent_data(disk, data, &live, selection_changed);
        },
        |counts| {
            static FIRST_LAYOUT_SAVE: std::sync::Once = std::sync::Once::new();
            if let Some(writer) = writer {
                FIRST_LAYOUT_SAVE.call_once(|| crate::diag::log(&format!(
                    "[persist] first save window={writer} workspaces={} tabs={} pid={}",
                    counts.workspaces, counts.tabs, std::process::id()
                )));
            }
        },
    )
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
    selection_changed: bool,
) {
    disk.schema_version = data.schema_version;
    let mut workspaces = data.workspaces;
    let carried = carry_over_live_workspaces(&disk.workspaces, &workspaces, live);
    let keep_selection = !selection_changed && disk.active_workspace_id.as_ref().is_some_and(|id| {
        carried.iter().any(|row| &row.id == id && has_restorable_panes(row))
    });
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
    let ailog_claude_fallback_root = disk.settings.ailog_claude_fallback_root.clone();
    disk.settings = data.settings;
    disk.settings.dirty_save_mode = dirty_save_mode;
    disk.settings.osc7_tracking_enabled = osc7_tracking_enabled;
    disk.settings.ailog_usd_jpy_rate = ailog_usd_jpy_rate;
    disk.settings.ailog_mirror_full_text_root = ailog_mirror_full_text_root;
    disk.settings.ailog_claude_fallback_root = ailog_claude_fallback_root;
    if !keep_selection {
        disk.active_workspace_id = data.active_workspace_id;
        disk.active_pane_id = data.active_pane_id;
        disk.active_tab_id = data.active_tab_id;
    }
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

/// Current PTY launch/argv/self-hook identity also protects close snapshots and
/// peer fragments from persisting a display-only transcript scan.
fn canonicalize_live_agent_sessions(data: &mut PersistentData, mut identity: impl FnMut(&str) -> Option<(String, String)>) {
    for workspace in &mut data.workspaces {
        for pane in &mut workspace.panes {
            let Some(tabs) = pane.tabs.as_mut() else { continue; };
            for tab in tabs {
                if tab.r#type.as_deref().is_some_and(|kind| kind != "terminal") { continue; }
                let Some((kind, id)) = tab.session_id.as_deref().and_then(&mut identity) else { continue; };
                tab.claude_session_id = (kind == "claude").then(|| id.clone());
                tab.agent_kind = Some(kind.clone());
                tab.agent_session_id = Some(id);
                if let Some(agent_id) = agent_id_for_kind(Some(&kind)) { tab.agent_id = agent_id.to_string(); }
            }
            sync_pane_from_active_tab(pane);
        }
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

        let envelope = load_persistent_data_for(path.as_path(), None).unwrap();
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
            let error = save_persistent_data_for(path.as_path(), PersistentData::default(), None, None, false)
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
                    save_persistent_data_for(clean_path.as_path(), PersistentData::default(), None, None, false)
                        .expect_err("process latch must reject a different clean target");
                assert_eq!(latched_error.kind(), "unsupportedSchema");
                assert_eq!(latched_error.schema_version(), Some(999));
                assert!(!clean_path.exists());
            }
        }
    }

    fn l3_workspace(id: &str, owner: &str, tabs: serde_json::Value) -> storage::WorkspaceConfig {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "grid_template_id": "1x1", "created_at": 0,
            "window_group": {"label": owner},
            "panes": [{"agent_id": "shell", "pane_id": "pane", "tabs": tabs}],
        })).unwrap()
    }

    #[test]
    fn l3_76_carrying_an_unpublished_child_preserves_its_selection() {
        let tabs = serde_json::json!([{"agent_id": "shell", "tab_id": "tab"}]);
        let mut disk = PersistentData {
            workspaces: vec![l3_workspace("child", "mycmux-w1", tabs.clone())],
            active_workspace_id: Some("child".into()),
            active_pane_id: Some("pane".into()),
            active_tab_id: Some("tab".into()),
            ..Default::default()
        };
        let save = PersistentData {
            workspaces: vec![l3_workspace("main", "main", tabs)],
            active_workspace_id: Some("main".into()),
            ..Default::default()
        };
        merge_persistent_data(&mut disk, save, &HashSet::from(["child".into()]), false);
        assert_eq!(disk.workspaces.len(), 2);
        assert_eq!((disk.active_workspace_id.as_deref(), disk.active_pane_id.as_deref(), disk.active_tab_id.as_deref()),
            (Some("child"), Some("pane"), Some("tab")));
    }

    #[test]
    fn l3_drop_84_an_acquired_row_and_selection_survive_one_save_after_close() {
        let tabs = serde_json::json!([{"agent_id": "shell", "tab_id": "tab"}]);
        let child = l3_workspace("child", "mycmux-w1", tabs.clone());
        let main = l3_workspace("main", "main", tabs);
        let mut disk = PersistentData { workspaces: vec![main.clone()], ..Default::default() };
        let stale = PersistentData {
            workspaces: vec![main, child],
            active_workspace_id: Some("child".into()),
            active_pane_id: Some("pane".into()),
            active_tab_id: Some("tab".into()),
            ..Default::default()
        };
        let registry = WindowRegistry::new();
        registry.publish_fragment(crate::window_registry::WindowFragment {
            window_label: "mycmux-w1".into(),
            workspaces: vec![serde_json::to_value(&stale.workspaces[1]).unwrap()],
            ..Default::default()
        });
        registry.forget_closed_window("mycmux-w1");
        assert!(registry.window_for_workspace("child").is_none());

        merge_persistent_data(&mut disk, stale, &registry.held_workspace_ids(), false);
        assert_eq!(disk.workspaces.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["main", "child"]);
        assert_eq!(disk.active_workspace_id.as_deref(), Some("child"));
        assert_eq!(disk.active_pane_id.as_deref(), Some("pane"));
        assert_eq!(disk.active_tab_id.as_deref(), Some("tab"));
    }

    #[test]
    fn l3_107_empty_tab_rows_do_not_keep_unreleasable_startup_holds() {
        let registry = WindowRegistry::new();
        let data = PersistentData {
            workspaces: vec![l3_workspace("empty", "main", serde_json::json!([])),
                l3_workspace("live", "main", serde_json::json!([{"agent_id": "shell"}]))],
            ..Default::default()
        };
        hold_loaded_workspaces(&registry, &data);
        assert!(registry.held_workspace_ids().contains("live"));
        assert!(!registry.held_workspace_ids().contains("empty"));
        assert!(registry.workspace_ids_for_save().contains("empty"));
        let mut on_disk = data.clone();
        let visible = PersistentData { workspaces: vec![data.workspaces[1].clone()], ..Default::default() };
        merge_persistent_data(&mut on_disk, visible, &registry.workspace_ids_for_save(), false);
        assert!(on_disk.workspaces.iter().any(|row| row.id == "empty"));
    }

    #[test]
    fn l3_fix2_03_empty_duplicate_cannot_change_the_owner_of_a_recoverable_startup_workspace() {
        let registry = WindowRegistry::new();
        let saved = l3_workspace("detached", "mycmux-w1", serde_json::json!([{
            "agent_id": "codex", "tab_id": "tab", "agent_session_id": "conversation"
        }]));
        let data = PersistentData {
            workspaces: vec![
                l3_workspace("main", "main", serde_json::json!([{"agent_id": "shell"}])),
                saved.clone(),
                l3_workspace("detached", "mycmux-w1", serde_json::json!([])),
            ],
            ..Default::default()
        };
        hold_loaded_workspaces(&registry, &data);
        registry.queue_adoption("mycmux-w1", vec![serde_json::to_value(saved).unwrap()]);
        let rows = registry.release_all("mycmux-w1", "main");
        registry.forget_window("mycmux-w1");

        assert_eq!(rows[0]["preserve_workspace_identity"], serde_json::Value::Bool(true));
        let mut row: storage::WorkspaceConfig = serde_json::from_value(rows[0].clone()).unwrap();
        row.window_group = None;
        let mut disk = data;
        let next = PersistentData { workspaces: vec![disk.workspaces[0].clone(), row], ..Default::default() };
        registry.publish_fragment(crate::window_registry::WindowFragment {
            window_label: "main".into(),
            workspaces: serde_json::to_value(&next.workspaces).unwrap().as_array().unwrap().clone(),
            ..Default::default()
        });
        merge_persistent_data(&mut disk, next, &registry.workspace_ids_for_save(), false);
        let restart: PersistentData = serde_json::from_slice(&serde_json::to_vec(&disk).unwrap()).unwrap();
        assert_eq!(restart.workspaces.iter().filter(|row| row.id == "detached").count(), 1);
        assert_eq!(restart.workspaces[1].panes[0].tabs.as_ref().unwrap()[0].agent_session_id.as_deref(), Some("conversation"));
    }

    #[test]
    fn l3_fix3_01_last_window_close_keeps_the_saved_layout_on_restart() {
        let _serial = storage::persistence_test_lock();
        storage::reset_quarantined_schema_for_test();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let row = l3_workspace("saved", "main", serde_json::json!([{
            "agent_id": "shell", "tab_id": "last-tab"
        }]));
        let saved = PersistentData {
            workspaces: vec![row.clone()],
            active_workspace_id: Some("saved".into()),
            active_tab_id: Some("last-tab".into()),
            ..Default::default()
        };
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let registry = WindowRegistry::new();
        registry.publish_fragment(crate::window_registry::WindowFragment {
            window_label: "main".into(),
            workspaces: vec![serde_json::to_value(row).unwrap()],
            ..Default::default()
        });

        registry.set_close_intent("main", true);
        assert!(registry.take_close_intent("main"));
        registry.forget_closed_window("main");

        let restarted = storage::load(path.as_path()).unwrap();
        assert_eq!(restarted.active_workspace_id.as_deref(), Some("saved"));
        assert_eq!(restarted.active_tab_id.as_deref(), Some("last-tab"));
        assert_eq!(restarted.workspaces[0].panes[0].tabs.as_ref().unwrap()[0].tab_id.as_deref(), Some("last-tab"));
    }

    #[test]
    fn l3_fix2_15_later_explicit_selection_replaces_the_carried_startup_selection() {
        let tabs = serde_json::json!([{"agent_id": "shell", "tab_id": "tab"}]);
        let mut disk = PersistentData {
            workspaces: vec![l3_workspace("child", "mycmux-w1", tabs.clone())],
            active_workspace_id: Some("child".into()),
            ..Default::default()
        };
        let mut save = PersistentData {
            workspaces: vec![l3_workspace("initial", "main", tabs.clone()), l3_workspace("chosen", "main", tabs)],
            active_workspace_id: Some("initial".into()),
            ..Default::default()
        };
        let live = HashSet::from(["child".into()]);
        merge_persistent_data(&mut disk, save.clone(), &live, false);
        assert_eq!(disk.active_workspace_id.as_deref(), Some("child"));
        save.active_workspace_id = Some("chosen".into());
        merge_persistent_data(&mut disk, save, &live, true);
        assert!(disk.workspaces.iter().any(|row| row.id == "child"));
        assert_eq!(disk.active_workspace_id.as_deref(), Some("chosen"));
    }

    #[test]
    fn l3_fix2_24_unsupported_tabs_are_metadata_without_a_live_startup_hold() {
        let registry = WindowRegistry::new();
        let input = PersistentData {
            workspaces: vec![l3_workspace("future", "main", serde_json::json!([{
                "agent_id": "shell", "tab_id": "future-tab", "lifecycle": "future-mode",
            }]))],
            ..Default::default()
        };
        hold_loaded_workspaces(&registry, &input);
        assert!(!registry.held_workspace_ids().contains("future"));
        let mut disk = input;
        merge_persistent_data(&mut disk, PersistentData::default(), &registry.workspace_ids_for_save(), false);
        assert_eq!(disk.workspaces[0].panes[0].tabs.as_ref().unwrap()[0].lifecycle.as_deref(), Some("future-mode"));
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
            agent_account_id: None,
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
            delegated_by_tab_id: None,
            delegated_by_agent_session_id: None,
            delegated_at: None,
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
            ("main".into(), storage::WindowGroupConfig { label: "main".into(), frame: None, decorated: Some(true), native_tearout: Some(false), maximized: None,
                active_workspace_id: Some("main-ws".into()), active_pane_id: None, active_tab_id: None }),
            ("mycmux-w2".into(), storage::WindowGroupConfig { label: "mycmux-w2".into(), frame: Some(inner.clone()), decorated: Some(false), native_tearout: Some(true), maximized: Some(true),
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
            assert_eq!(group.maximized, Some(true));
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
        save_persistent_data_for(path.as_path(), data, None, None, false).unwrap();
        let first = std::fs::read(&path).unwrap();
        for _ in 0..6 {
            let envelope = load_persistent_data_for(path.as_path(), None).unwrap();
            assert_eq!(envelope.schema_version, 1);
            let data = envelope.data.unwrap();
            assert_eq!(data.workspaces[0].window_group.as_ref().unwrap().label, "mycmux-w2");
            save_persistent_data_for(path.as_path(), data, None, None, false).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), first);
        }
    }

    #[test]
    fn first_main_save_keeps_both_child_groups_before_their_first_fragment() {
        use crate::window_registry::{WindowFragment, WindowRegistry};

        let registry = WindowRegistry::new();
        let mut disk = PersistentData::default();
        for (id, label) in [("primary", "main"), ("one", "mycmux-w1"), ("two", "mycmux-w2")] {
            disk.workspaces.push(l3_workspace(id, label, serde_json::json!([{"agent_id": "shell"}])));
        }
        hold_loaded_workspaces(&registry, &disk);
        let first_child = serde_json::to_value(&disk.workspaces[1]).unwrap();
        registry.queue_adoption("mycmux-w1", vec![first_child.clone()]);
        assert_eq!(registry.take_pending_adoption("mycmux-w1"), vec![first_child]);
        // w2 has not even been created when the first save is assembled.
        let mut incoming = disk.clone();
        incoming.workspaces.truncate(1);
        registry.publish_fragment(WindowFragment {
            window_label: "main".into(),
            workspaces: vec![serde_json::to_value(&incoming.workspaces[0]).unwrap()],
            ..Default::default()
        });

        merge_persistent_data(&mut disk, incoming, &registry.held_workspace_ids(), false);

        let owners: Vec<_> = disk.workspaces.iter().map(|workspace|
            workspace.window_group.as_ref().unwrap().label.as_str()).collect();
        assert_eq!(owners, ["main", "mycmux-w1", "mycmux-w2"]);

        registry.publish_fragment(WindowFragment {
            window_label: "mycmux-w1".into(),
            workspaces: vec![serde_json::to_value(&disk.workspaces[1]).unwrap()],
            ..Default::default()
        });
        registry.publish_fragment(WindowFragment {
            window_label: "mycmux-w1".into(),
            ..Default::default()
        });
        assert!(!registry.held_workspace_ids().contains("one"));

        // Failed startup windows keep their layouts; explicit close releases them.
        registry.forget_window("mycmux-w2");
        assert!(registry.held_workspace_ids().contains("two"));
        registry.forget_closed_window("mycmux-w2");
        assert!(!registry.held_workspace_ids().contains("two"));
    }

    #[test]
    fn first_save_with_only_a_new_visible_tab_keeps_the_saved_main_layout() {
        let _serial = storage::persistence_test_lock();
        storage::reset_quarantined_schema_for_test();
        let _reset = SchemaLatchReset;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let registry = WindowRegistry::new();
        let make_workspace = |id: &str, count: usize| -> storage::WorkspaceConfig {
            let tabs: Vec<_> = (0..count).map(|index| serde_json::json!({
                "agent_id": "shell", "tab_id": format!("{id}-{index}"),
            })).collect();
            serde_json::from_value(serde_json::json!({
                "id": id, "name": id, "grid_template_id": "1x1", "created_at": 0,
                "window_group": {"label": "main"},
                "panes": [{"agent_id": "shell", "pane_id": id, "tabs": tabs}],
            })).unwrap()
        };
        let original = PersistentData {
            workspaces: vec![
                make_workspace("original-a", 10), make_workspace("original-b", 9),
                make_workspace("original-c", 9), make_workspace("original-d", 9),
            ],
            ..Default::default()
        };
        save_persistent_data_for(path.as_path(), original, None, None, false).unwrap();
        load_persistent_data_for(path.as_path(), Some(&registry)).unwrap();
        let visible = PersistentData {
            workspaces: vec![make_workspace("visible", 1)],
            ..Default::default()
        };
        registry.publish_fragment(crate::window_registry::WindowFragment {
            window_label: "main".into(),
            workspaces: vec![serde_json::to_value(&visible.workspaces[0]).unwrap()],
            ..Default::default()
        });

        save_persistent_data_for(path.as_path(), visible, Some(&registry), None, false).unwrap();

        let written = storage::load(path.as_path()).unwrap();
        let layout: Vec<_> = written.workspaces.iter().map(|workspace| (
            workspace.id.as_str(), workspace.panes[0].tabs.as_ref().unwrap().len(),
        )).collect();
        assert_eq!(layout, [
            ("visible", 1), ("original-a", 10), ("original-b", 9),
            ("original-c", 9), ("original-d", 9),
        ]);
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

        merge_persistent_data(&mut disk, incoming, &live, false);

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

        merge_persistent_data(&mut disk, incoming, &live, false);

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
        disk.settings.ailog_claude_fallback_root = Some("X:\\restored-projects".to_string());
        let mut incoming = PersistentData::default();
        incoming.settings.dirty_save_mode = false;
        incoming.settings.osc7_tracking_enabled = true;
        incoming.settings.ailog_usd_jpy_rate = 150.0;
        incoming.settings.ailog_mirror_full_text_root = None;
        incoming.settings.font_size = 19;

        merge_persistent_data(&mut disk, incoming, &HashSet::new(), false);

        assert!(disk.settings.dirty_save_mode);
        assert!(!disk.settings.osc7_tracking_enabled);
        assert_eq!(disk.settings.ailog_usd_jpy_rate, 155.0);
        assert_eq!(
            disk.settings.ailog_mirror_full_text_root.as_deref(),
            Some("X:\\archive")
        );
        assert_eq!(disk.settings.font_size, 19);
        assert_eq!(disk.settings.ailog_claude_fallback_root.as_deref(),Some("X:\\restored-projects"));
    }
    #[test]
    fn si_t2_canonical_save_overrides_scanned_identity_and_preserves_unstarted_tabs() {
        let mut data = PersistentData::default();
        data.workspaces = vec![serde_json::from_value(serde_json::json!({
            "id":"workspace", "name":"Workspace", "grid_template_id":"1x1", "created_at":0,
            "panes":[{"pane_id":"pane", "agent_id":"claude-code", "label":null, "cwd":null,
                "active_tab_id":"tab-a", "agent_session_id":"scanned-x", "agent_kind":"claude",
                "tabs":[{"tab_id":"tab-a", "session_id":"pty-a", "agent_id":"claude-code", "label":null,
                    "agent_kind":"claude", "agent_session_id":"scanned-x", "claude_session_id":"scanned-x"},
                    {"tab_id":"tab-b", "session_id":"not-started", "agent_id":"claude-code", "label":null,
                    "agent_kind":"claude", "agent_session_id":"saved-b"}]}]
        })).unwrap()];
        canonicalize_live_agent_sessions(&mut data, |session| (session == "pty-a").then(|| ("claude".into(), "trusted-a".into())));
        let pane = &data.workspaces[0].panes[0];
        assert_eq!(pane.agent_session_id.as_deref(), Some("trusted-a"));
        assert_eq!(pane.tabs.as_ref().unwrap()[0].claude_session_id.as_deref(), Some("trusted-a"));
        assert_eq!(pane.tabs.as_ref().unwrap()[1].agent_session_id.as_deref(), Some("saved-b"));
    }

}
