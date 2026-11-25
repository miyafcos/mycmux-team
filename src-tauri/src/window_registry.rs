//! Multi-window workspace registry (Phase 3b).
//!
//! Design: `docs/plans/2026-08-09-multiwindow-tearout-design.md` (§State sync).
//!
//! Every window runs the full Zustand stores but holds **only its assigned
//! workspaces**. This registry is the process-wide index that makes that
//! sharding safe:
//!
//! - `assignments`   workspace id → owning window label (socket routing, and
//!                   the self-healing answer to "who owns this workspace?"),
//! - `fragments`     window label → that window's last published workspace
//!                   list + active selection. The **main window is still the
//!                   sole `data.json` writer**; its `buildSnapshot` appends
//!                   every non-main fragment so a torn-out workspace never
//!                   disappears from `data.json` (the file every launch
//!                   restores from),
//! - `pending_adoptions`  window label → workspaces waiting to be picked up by
//!                   that window on boot (tear-out) or on merge-back (child
//!                   close / crash).
//!
//! Workspaces are kept as opaque `serde_json::Value` on purpose: the
//! `WorkspaceConfig` schema lives in `db::storage` and is mirrored in
//! `src/lib/ipc.ts`; round-tripping fragments through a second Rust struct
//! would silently drop any field this file forgot to mirror.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

pub const MAIN_WINDOW_LABEL: &str = "main";

/// Broadcast (revision counter payload) whenever ownership changes.
pub const WINDOW_REGISTRY_CHANGED_EVENT: &str = "mycmux://window-registry-changed";
/// Targeted (`emit_to`) at the window that has workspaces waiting for it.
pub const WINDOW_ADOPT_EVENT: &str = "mycmux://window-adopt";

/// One window's published view of the world.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WindowFragment {
    pub window_label: String,
    /// Synthetic entry: workspaces queued *for* `window_label` that it has not
    /// adopted yet. Between a tear-out and the new window's first publish the
    /// queue is the only holder of those workspaces, so main's union merge has
    /// to see them or `data.json` would drop them for that stretch. Windows
    /// never publish this flag (serde default `false`).
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub workspaces: Vec<Value>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub active_pane_id: Option<String>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
}

/// Display-only index. Never copy a fragment's scrollback into a polling read.
#[derive(Debug, Serialize, Deserialize)]
pub struct WindowTabIndex {
    pub window_label: String,
    pub pending: bool,
    #[serde(default)]
    pub account_management_ready: bool,
    #[serde(default)]
    pub account_management_subscription: Option<WindowAccountManagementSubscription>,
    pub workspaces: Vec<WindowTabWorkspace>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowAccountManagementSubscription {
    pub publication_id: String,
    pub subscription_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowTabWorkspace {
    pub id: String,
    pub name: String,
    pub panes: Vec<WindowTabPane>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowTabPane {
    pub id: String,
    pub tabs: Vec<WindowTabIndexTab>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowTabIndexTab {
    pub tab_id: String,
    pub session_id: String,
    pub agent_id: String,
    #[serde(flatten)]
    fields: serde_json::Map<String, Value>,
    pub pty_alive: bool,
    pub live_agent_kind: Option<String>,
}

fn display_tab_index(tab: &Value, pane: &Value) -> Option<WindowTabIndexTab> {
    let mut fields = serde_json::Map::new();
    // Keep serialized WorkspaceConfig names, rather than frontend runtime names.
    for key in [
        "label",
        "label_source",
        "display_name",
        "display_name_source",
        "type",
        "preset_id",
        "cwd",
        "agent_kind",
        "agent_session_id",
        "claude_session_id",
        "source_kind",
        "source_path",
        "lifecycle",
        "delegated_by_tab_id",
        "delegated_by_agent_session_id",
    ] {
        if let Some(value) = tab
            .get(key)
            .filter(|value| value.is_string() || value.is_null())
        {
            fields.insert(key.to_string(), value.clone());
        }
    }
    if let Some(value) = tab.get("delegated_at").filter(|value| value.is_number()) {
        fields.insert("delegated_at".into(), value.clone());
    }
    let command = tab
        .get("command_argv")
        .or_else(|| tab.get("commandArgv"))
        .and_then(Value::as_array)
        .and_then(|args| args.first())
        .and_then(Value::as_str);
    fields.insert(
        "command_argv".into(),
        Value::Array(
            command
                .into_iter()
                .map(|value| Value::String(value.into()))
                .collect(),
        ),
    );
    let mut launch_env = serde_json::Map::new();
    let target = tab
        .get("launch_env")
        .and_then(|env| env.get("MYCMUX_LAUNCH_TARGET"))
        .or_else(|| {
            pane.get("launch_env")
                .and_then(|env| env.get("MYCMUX_LAUNCH_TARGET"))
        })
        .and_then(Value::as_str);
    if let Some(target) = target {
        launch_env.insert("MYCMUX_LAUNCH_TARGET".into(), Value::String(target.into()));
    }
    fields.insert("launch_env".into(), Value::Object(launch_env));
    Some(WindowTabIndexTab {
        tab_id: tab.get("tab_id")?.as_str()?.to_string(),
        session_id: tab.get("session_id")?.as_str()?.to_string(),
        agent_id: tab
            .get("agent_id")
            .or_else(|| pane.get("agent_id"))
            .and_then(Value::as_str)
            .unwrap_or("shell-starter")
            .to_string(),
        fields,
        pty_alive: false,
        live_agent_kind: None,
    })
}

fn display_workspace_index(workspaces: &[Value]) -> Vec<WindowTabWorkspace> {
    workspaces
        .iter()
        .filter_map(|workspace| {
            let id = workspace.get("id")?.as_str()?.to_string();
            let panes = workspace
                .get("panes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|pane| {
                    let id = pane
                        .get("pane_id")
                        .or_else(|| pane.get("id"))?
                        .as_str()?
                        .to_string();
                    let tabs = pane
                        .get("tabs")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|tab| display_tab_index(tab, pane))
                        .collect();
                    Some(WindowTabPane { id, tabs })
                })
                .collect();
            Some(WindowTabWorkspace {
                name: workspace
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                id,
                panes,
            })
        })
        .collect()
}

/// Payload of `mycmux://window-adopt`. The receiving window drains
/// `take_pending_adoption` rather than trusting this payload — the queue is the
/// authority, so a duplicate event can never restore a workspace twice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowAdoptPayload {
    pub from_label: String,
    pub to_label: String,
    pub workspace_ids: Vec<String>,
}

/// `WorkspaceConfig.id` of a serialized workspace, if it has one.
pub fn workspace_config_id(value: &Value) -> Option<String> {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

pub fn workspace_config_ids(values: &[Value]) -> Vec<String> {
    values.iter().filter_map(workspace_config_id).collect()
}

enum StartupRow {
    Awaiting(Option<String>),
    MetadataOnly,
}

struct WorkspaceWindowCreation {
    id: String,
    source: String,
    active: std::sync::Arc<AtomicBool>,
}

#[derive(Default)]
struct WindowPublisher {
    publication_id: String,
    account_management_document: u64,
    account_management_sequence: u64,
    account_management_subscription: Option<String>,
}

#[derive(Default)]
pub struct WindowRegistry {
    workspace_window_creations: DashMap<String, WorkspaceWindowCreation>,
    assignments: DashMap<String, String>,
    fragments: DashMap<String, WindowFragment>,
    fragment_publishers: Mutex<HashMap<String, WindowPublisher>>,
    pending_adoptions: DashMap<String, Vec<Value>>,
    // Process startup only. Stays initialized after the last hold is cleared so
    // a later read cannot put deliberately closed workspaces back under guard.
    startup_workspaces: Mutex<Option<HashMap<String, StartupRow>>>,
    pub(crate) child_window_labels: crate::commands::window::ChildWindowLabelReservations,
    revision: AtomicU64,
    leader: std::sync::Mutex<Option<String>>,
    closing: std::sync::Mutex<std::collections::HashSet<String>>,
    shutdown_started: AtomicBool,
}

impl WindowRegistry {
    pub fn new() -> Self {
        let registry = Self::default();
        // The configured main window is created once per process.
        registry.fragment_publishers.lock().unwrap()
            .insert(MAIN_WINDOW_LABEL.into(), WindowPublisher::default());
        registry
    }

    pub fn hold_startup_workspaces<'a>(&self, owners: impl Iterator<Item = (&'a str, Option<&'a str>)>) {
        self.startup_workspaces.lock().unwrap().get_or_insert_with(|| {
            let mut rows = HashMap::new();
            for (id, label) in owners.filter(|(id, _)| !id.is_empty()) {
                let current = rows.entry(id.to_owned()).or_insert(StartupRow::MetadataOnly);
                if let (StartupRow::MetadataOnly, Some(label)) = (&*current, label) {
                    *current = StartupRow::Awaiting(Some(label.to_owned()));
                }
            }
            rows
        });
    }

    pub(crate) fn track_workspace_window(
        &self, label: &str, id: String, source: String,
    ) -> std::sync::Arc<AtomicBool> {
        let active = std::sync::Arc::new(AtomicBool::new(true));
        self.workspace_window_creations.insert(label.to_owned(), WorkspaceWindowCreation {
            id, source, active: active.clone(),
        });
        active
    }

    pub(crate) fn matches_workspace_window(&self, label: &str, id: &str, source: &str) -> bool {
        self.workspace_window_creations.get(label).is_some_and(|creation| {
            creation.id == id && creation.source == source && creation.active.load(Ordering::Acquire)
        })
    }

    pub(crate) fn cancel_workspace_window(&self, label: &str, id: &str, source: &str) {
        if let Some(creation) = self.workspace_window_creations.get(label) {
            if creation.id == id && creation.source == source {
                creation.active.store(false, Ordering::Release);
            }
        }
    }

    /// A process-wide mutex makes competing claims exclusive and repeatable.
    pub fn claim_leader(&self, label: &str) -> bool {
        let mut owner = self.leader.lock().unwrap();
        if owner.is_none() {
            *owner = Some(label.to_string());
        }
        owner.as_deref() == Some(label)
    }

    pub fn release_leader(&self, label: &str) -> bool {
        let mut owner = self.leader.lock().unwrap();
        if owner.as_deref() != Some(label) { return false; }
        *owner = None;
        self.bump();
        true
    }

    pub fn leader(&self) -> Option<String> {
        self.leader.lock().unwrap().clone()
    }

    pub fn set_close_intent(&self, label: &str, closing: bool) {
        let mut labels = self.closing.lock().unwrap();
        if closing { labels.insert(label.to_string()); } else { labels.remove(label); }
    }

    pub(crate) fn set_publisher_close_intent(
        &self,
        label: &str,
        publication_id: Option<&str>,
        closing: bool,
    ) -> bool {
        let publishers = self.fragment_publishers.lock().unwrap();
        if publishers.get(label).map(|publisher| publisher.publication_id.as_str())
            != Some(publication_id.unwrap_or_default())
        {
            return false;
        }
        self.set_close_intent(label, closing);
        true
    }

    pub fn is_closing(&self, label: &str) -> bool {
        self.closing.lock().unwrap().contains(label)
    }

    pub fn take_close_intent(&self, label: &str) -> bool {
        self.closing.lock().unwrap().remove(label)
    }

    /// Normal window closure waits for the last peer; explicit exit/restart does not.
    /// Both paths share the same exactly-once cleanup latch.
    pub fn begin_shutdown(&self, live_windows: usize, code: Option<i32>) -> bool {
        (code.is_some() || live_windows == 0) && self.shutdown_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }

    pub fn rescue_target(&self, dying: &str, live: &[String]) -> Option<String> {
        let mut candidates: Vec<_> = live.iter()
            .filter(|label| label.as_str() != dying && !self.is_closing(label))
            .cloned().collect();
        candidates.sort();
        self.leader().filter(|owner| candidates.contains(owner))
            .or_else(|| candidates.into_iter().next())
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    fn bump(&self) -> u64 {
        self.revision.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Point every listed workspace at `label`, dropping any stale assignment
    /// that used to point at it.
    pub fn assign(&self, workspace_ids: &[String], label: &str) {
        let mut startup = self.startup_workspaces.lock().unwrap();
        for workspace_id in workspace_ids {
            self.assignments
                .insert(workspace_id.clone(), label.to_string());
            if let Some(StartupRow::Awaiting(owner)) = startup.as_mut().and_then(|held| held.get_mut(workspace_id)) {
                *owner = Some(label.to_string());
            }
        }
        self.bump();
    }

    pub fn window_for_workspace(&self, workspace_id: &str) -> Option<String> {
        self.assignments
            .get(workspace_id)
            .map(|entry| entry.value().clone())
    }

    pub fn workspaces_assigned_to(&self, label: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .assignments
            .iter()
            .filter(|entry| entry.value() == label)
            .map(|entry| entry.key().clone())
            .collect();
        ids.sort();
        ids
    }

    /// Queue workspaces for a window to pick up (tear-out target on boot,
    /// merge-back target on child close/crash). Appends, so two releases in
    /// flight never clobber each other.
    pub fn queue_adoption(&self, label: &str, workspaces: Vec<Value>) {
        if workspaces.is_empty() {
            return;
        }
        let workspace_ids = workspace_config_ids(&workspaces);
        self.pending_adoptions
            .entry(label.to_string())
            .or_default()
            .extend(workspaces);
        self.assign(&workspace_ids, label);
    }

    /// Drain the queue. Draining is the commit point: a second caller (or a
    /// duplicate `window-adopt` event) gets an empty list instead of a
    /// double restore.
    pub fn take_pending_adoption(&self, label: &str) -> Vec<Value> {
        self.pending_adoptions
            .remove(label)
            .map(|(_, workspaces)| workspaces)
            .unwrap_or_default()
    }

    pub fn pending_adoption_len(&self, label: &str) -> usize {
        self.pending_adoptions
            .get(label)
            .map(|entry| entry.value().len())
            .unwrap_or(0)
    }

    /// Tear-out receipts remove only their escrow, leaving unrelated handoffs.
    pub fn remove_pending_adoption(&self, label: &str, ids: &[String]) {
        if let Some(mut pending) = self.pending_adoptions.get_mut(label) {
            pending.retain(|config| workspace_config_id(config).is_none_or(|id| !ids.contains(&id)));
        }
        for id in ids {
            let published = self.fragment(label).is_some_and(|fragment|
                workspace_config_ids(&fragment.workspaces).contains(id));
            if !published {
                self.assignments.remove_if(id, |_, owner| owner == label);
            }
        }
        self.bump();
    }

    pub(crate) fn register_fragment_publisher(&self, label: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.fragment_publishers.lock().unwrap().insert(label.to_owned(), WindowPublisher {
            publication_id: id.clone(),
            ..Default::default()
        });
        id
    }

    pub(crate) fn unregister_fragment_publisher(&self, label: &str) {
        self.fragment_publishers.lock().unwrap().remove(label);
    }

    pub(crate) fn account_management_document(
        &self,
        label: &str,
        publication_id: Option<&str>,
    ) -> Option<u64> {
        self.fragment_publishers.lock().unwrap().get(label)
            .filter(|publisher| publisher.publication_id == publication_id.unwrap_or_default())
            .map(|publisher| publisher.account_management_document)
    }

    pub(crate) fn account_management_window<T>(
        &self,
        label: &str,
        expected: &WindowAccountManagementSubscription,
        get_window: impl FnOnce() -> Option<T>,
    ) -> Option<T> {
        let publishers = self.fragment_publishers.lock().unwrap();
        let publisher = publishers.get(label)?;
        if publisher.publication_id != expected.publication_id
            || publisher.account_management_subscription.as_deref() != Some(expected.subscription_id.as_str())
        {
            return None;
        }
        get_window()
    }

    pub(crate) fn invalidate_account_management_document(&self, label: &str) {
        if let Some(publisher) = self.fragment_publishers.lock().unwrap().get_mut(label) {
            publisher.account_management_document += 1;
            publisher.account_management_sequence = 0;
            publisher.account_management_subscription = None;
        }
    }

    pub(crate) fn set_account_management_ready(
        &self,
        label: &str,
        publication_id: Option<&str>,
        document: u64,
        sequence: u64,
        subscription_id: Option<String>,
    ) -> bool {
        let mut publishers = self.fragment_publishers.lock().unwrap();
        let Some(publisher) = publishers.get_mut(label).filter(|publisher| {
            publisher.publication_id == publication_id.unwrap_or_default()
                && publisher.account_management_document == document
        }) else { return false; };
        if sequence > publisher.account_management_sequence {
            publisher.account_management_sequence = sequence;
            publisher.account_management_subscription = subscription_id;
        }
        true
    }

    pub(crate) fn publish_live_fragment(&self, fragment: WindowFragment, publication_id: Option<&str>) -> bool {
        // Hold the generation check through the mutation. Destruction either
        // clears an earlier publish or invalidates the source before it writes.
        let publishers = self.fragment_publishers.lock().unwrap();
        let closing = self.closing.lock().unwrap();
        if publishers.get(&fragment.window_label).map(|publisher| publisher.publication_id.as_str())
            != Some(publication_id.unwrap_or_default())
            || closing.contains(&fragment.window_label)
        {
            return false;
        }
        self.publish_fragment(fragment);
        true
    }

    /// Store a window's latest view and re-derive ownership from it. Ownership
    /// is re-derived (rather than merged) so a workspace that left this window
    /// stops being attributed to it even if the move itself was lost.
    pub fn publish_fragment(&self, fragment: WindowFragment) {
        let label = fragment.window_label.clone();
        let workspace_ids = workspace_config_ids(&fragment.workspaces);
        let published: std::collections::HashSet<&String> = workspace_ids.iter().collect();
        let mut startup = self.startup_workspaces.lock().unwrap();

        self.assignments.retain(|workspace_id, owner| {
            owner != &label || published.contains(workspace_id)
        });
        for workspace_id in &workspace_ids {
            self.assignments
                .insert(workspace_id.clone(), label.clone());
        }
        self.fragments.insert(label, fragment);
        if let Some(held) = startup.as_mut() {
            for id in &workspace_ids {
                held.remove(id);
            }
        }
        self.bump();
    }

    pub fn fragment(&self, label: &str) -> Option<WindowFragment> {
        self.fragments.get(label).map(|entry| entry.value().clone())
    }

    /// All fragments, sorted by label so the persisted workspace order is
    /// stable between saves.
    pub fn fragments(&self) -> Vec<WindowFragment> {
        let mut fragments: Vec<WindowFragment> = self
            .fragments
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        // A torn-out workspace lives only in the adoption queue until the new
        // window boots and publishes its first fragment. Leaving that window
        // out of the union would drop those workspaces from `data.json` for the
        // stretch in between -- and a crash in that stretch would lose them for
        // good. Emit them as synthetic entries; the consumer dedupes by
        // workspace id, so a late publish simply supersedes them.
        for entry in self.pending_adoptions.iter() {
            if entry.value().is_empty() {
                continue;
            }
            fragments.push(WindowFragment {
                window_label: entry.key().clone(),
                pending: true,
                workspaces: entry.value().clone(),
                active_workspace_id: None,
                active_pane_id: None,
                active_tab_id: None,
            });
        }
        // Published entries first so a stale pending copy never outranks the
        // window's own current view of the same workspace.
        fragments.sort_by(|a, b| {
            a.window_label
                .cmp(&b.window_label)
                .then(a.pending.cmp(&b.pending))
        });
        fragments
    }

    /// Project while holding each entry guard; only small display fields escape.
    /// Liveness is filled by the caller after every registry guard is released.
    pub fn tab_index(&self, caller: &str) -> Vec<WindowTabIndex> {
        let mut ready_windows: HashMap<_, _> = {
            let publishers = self.fragment_publishers.lock().unwrap();
            let closing = self.closing.lock().unwrap();
            publishers.iter()
                .filter(|(label, _)| label.as_str() != caller && !closing.contains(*label))
                .filter_map(|(label, publisher)| {
                    Some((label.clone(), WindowAccountManagementSubscription {
                        publication_id: publisher.publication_id.clone(),
                        subscription_id: publisher.account_management_subscription.clone()?,
                    }))
                })
                .collect()
        };
        let mut index = Vec::new();
        for entry in self.fragments.iter() {
            if entry.key() == caller {
                continue;
            }
            let subscription = ready_windows.remove(entry.key());
            index.push(WindowTabIndex {
                window_label: entry.key().clone(),
                pending: false,
                account_management_ready: subscription.is_some(),
                account_management_subscription: subscription,
                workspaces: display_workspace_index(&entry.value().workspaces),
            });
        }
        // A subscribed shell can answer before it publishes any layout data.
        index.extend(ready_windows.into_iter().map(|(window_label, subscription)| WindowTabIndex {
            window_label,
            pending: false,
            account_management_ready: true,
            account_management_subscription: Some(subscription),
            workspaces: Vec::new(),
        }));
        for entry in self.pending_adoptions.iter() {
            if entry.value().is_empty() {
                continue;
            }
            index.push(WindowTabIndex {
                window_label: entry.key().clone(),
                pending: true,
                account_management_ready: false,
                account_management_subscription: None,
                workspaces: display_workspace_index(entry.value()),
            });
        }
        index.sort_by(|a, b| {
            a.window_label
                .cmp(&b.window_label)
                .then(a.pending.cmp(&b.pending))
        });
        index
    }

    /// Move workspaces from one window to another: they leave the source
    /// fragment and land in the target's adoption queue. Returns what actually
    /// moved (a workspace the source never published cannot move).
    /// Serialize a drag handoff with the receiving window's close intent.
    pub fn release_to_open_window(
        &self, from_label: &str, workspace_ids: &[String], to_label: &str,
    ) -> Result<Vec<Value>, String> {
        let closing = self.closing.lock().unwrap();
        if closing.contains(to_label) { return Err("Receiving window is closing".to_string()); }
        let moved = self.release_workspaces(from_label, workspace_ids, to_label);
        drop(closing);
        Ok(moved)
    }

    pub fn release_workspaces(
        &self,
        from_label: &str,
        workspace_ids: &[String],
        to_label: &str,
    ) -> Vec<Value> {
        let wanted: std::collections::HashSet<&String> = workspace_ids.iter().collect();
        let mut moved: Vec<Value> = Vec::new();

        if let Some(mut entry) = self.fragments.get_mut(from_label) {
            let fragment = entry.value_mut();
            let mut kept: Vec<Value> = Vec::with_capacity(fragment.workspaces.len());
            for workspace in fragment.workspaces.drain(..) {
                match workspace_config_id(&workspace) {
                    Some(id) if wanted.contains(&id) => moved.push(workspace),
                    _ => kept.push(workspace),
                }
            }
            fragment.workspaces = kept;
        }

        if moved.is_empty() {
            return moved;
        }
        self.queue_adoption(to_label, moved.clone());
        moved
    }

    /// Everything the window still owns goes to `to_label`. Used by the
    /// `Destroyed` hook so a child that crashed (or was closed by the OS
    /// without running its merge-back handler) still hands its workspaces —
    /// and their live PTY sessions — back to main.
    pub fn release_all(&self, from_label: &str, to_label: &str) -> Vec<Value> {
        let ids = self
            .fragment(from_label)
            .map(|fragment| workspace_config_ids(&fragment.workspaces))
            .unwrap_or_default();
        if ids.is_empty() {
            // Nothing published, but a queued adoption may never have been
            // picked up (window died between open and boot).
            return self.rescue_pending_adoption(from_label, to_label);
        }
        let mut moved = self.release_workspaces(from_label, &ids, to_label);
        moved.extend(self.rescue_pending_adoption(from_label, to_label));
        moved
    }

    fn rescue_pending_adoption(&self, from_label: &str, to_label: &str) -> Vec<Value> {
        let mut pending = self.take_pending_adoption(from_label);
        if pending.is_empty() {
            return pending;
        }
        // A startup row is still held for disk carry-over until its ID is
        // published. Recover it under that ID, including its detached origin.
        let startup = self.startup_workspaces.lock().unwrap();
        if let Some(held) = startup.as_ref() {
            for config in &mut pending {
                let is_held = workspace_config_id(config)
                    .is_some_and(|id| matches!(held.get(&id), Some(StartupRow::Awaiting(_))));
                if let Some(row) = config.as_object_mut().filter(|_| is_held) {
                    row.insert("preserve_workspace_identity".into(), Value::Bool(true));
                }
            }
        }
        drop(startup);
        self.queue_adoption(to_label, pending.clone());
        pending
    }

    /// Drop everything the registry knows about a window. Call only after its
    /// workspaces have been released, or they are lost.
    pub fn forget_window(&self, label: &str) {
        let mut startup = self.startup_workspaces.lock().unwrap();
        if let Some(held) = startup.as_mut() {
            for (id, row) in held {
                if let StartupRow::Awaiting(owner) = row {
                    if owner.as_deref() == Some(label) &&
                        self.assignments.get(id).is_some_and(|actual| actual.value() == label) {
                        // The receiver took its queue but died before publishing.
                        *owner = None;
                    }
                }
            }
        }
        self.clear_window(label);
    }

    pub fn forget_closed_window(&self, label: &str) {
        let mut startup = self.startup_workspaces.lock().unwrap();
        if let Some(held) = startup.as_mut() {
            held.retain(|_, row| !matches!(row, StartupRow::Awaiting(Some(owner)) if owner == label));
        }
        self.clear_window(label);
    }

    fn clear_window(&self, label: &str) {
        self.workspace_window_creations.remove(label);
        self.fragments.remove(label);
        self.pending_adoptions.remove(label);
        self.assignments.retain(|_, owner| owner != label);
        self.bump();
    }

    /// Ids still held by published fragments, handoff queues or startup.
    ///
    /// Only the ids, because the save path asks this on every write and the
    /// values are whole workspaces.
    #[cfg(test)]
    pub fn held_workspace_ids(&self) -> std::collections::HashSet<String> {
        self.workspace_ids(false)
    }

    pub fn workspace_ids_for_save(&self) -> std::collections::HashSet<String> {
        self.workspace_ids(true)
    }

    fn workspace_ids(&self, include_metadata: bool) -> std::collections::HashSet<String> {
        // Do not let publication remove a startup hold between reading these
        // IDs and reading the fragment that supersedes them.
        let startup = self.startup_workspaces.lock().unwrap();
        let mut ids = std::collections::HashSet::new();
        if let Some(held) = startup.as_ref() {
            ids.extend(held.iter().filter_map(|(id, row)| {
                (include_metadata || matches!(row, StartupRow::Awaiting(_))).then(|| id.clone())
            }));
        }
        for entry in self.fragments.iter() {
            ids.extend(workspace_config_ids(&entry.value().workspaces));
        }
        for entry in self.pending_adoptions.iter() {
            ids.extend(workspace_config_ids(entry.value()));
        }
        ids
    }

    /// Labels the registry still holds state for (fragments, queues or
    /// assignments) — the input to orphan reconciliation.
    pub fn known_windows(&self) -> Vec<String> {
        let mut labels: std::collections::HashSet<String> = std::collections::HashSet::new();
        labels.extend(self.fragments.iter().map(|entry| entry.key().clone()));
        labels.extend(self.pending_adoptions.iter().map(|entry| entry.key().clone()));
        labels.extend(self.assignments.iter().map(|entry| entry.value().clone()));
        let mut labels: Vec<String> = labels.into_iter().collect();
        labels.sort();
        labels
    }

    /// Known windows that no longer exist (`live_labels` comes from
    /// `commands::window::all_window_labels`), excluding main itself.
    pub fn orphan_windows(&self, live_labels: &[String]) -> Vec<String> {
        self.known_windows()
            .into_iter()
            .filter(|label| label != MAIN_WINDOW_LABEL && !live_labels.contains(label))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dashboard_tab_index_excludes_own_published_copy_and_keeps_own_pending_copy() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("main", &["local"]));
        registry.publish_fragment(fragment("mycmux-w1", &["peer"]));
        registry.queue_adoption("main", vec![workspace("returning")]);
        let index = registry.tab_index("main");
        assert_eq!(index.len(), 2);
        assert!(index.iter().any(|entry| entry.window_label == "main"
            && entry.pending
            && entry.workspaces[0].id == "returning"));
        assert!(index
            .iter()
            .all(|entry| entry.pending || entry.window_label != "main"));
    }

    #[test]
    fn dashboard_tab_index_defaults_account_management_readiness_to_false() {
        let registry = WindowRegistry::new();
        let label = "mycmux-w1";
        let publisher = registry.register_fragment_publisher(label);
        assert!(registry.publish_live_fragment(fragment(label, &["peer"]), Some(&publisher)));
        registry.queue_adoption(label, vec![workspace("pending")]);

        let index = serde_json::to_value(registry.tab_index("main")).unwrap();
        assert_eq!(index[0]["account_management_ready"], json!(false));
        assert_eq!(index[1]["account_management_ready"], json!(false));
        let old: WindowTabIndex = serde_json::from_value(json!({
            "window_label": label, "pending": false, "workspaces": [],
        })).unwrap();
        assert!(!old.account_management_ready);
        assert!(old.account_management_subscription.is_none());
        let old_ready: WindowTabIndex = serde_json::from_value(json!({
            "window_label": label, "pending": false, "workspaces": [], "account_management_ready": true,
        })).unwrap();
        assert!(old_ready.account_management_subscription.is_none());
    }

    #[test]
    fn dashboard_account_management_readiness_tracks_subscription_close_and_window_generation() {
        let registry = WindowRegistry::new();
        let label = "mycmux-w1";
        let first = registry.register_fragment_publisher(label);
        assert!(registry.set_account_management_ready(label, Some(&first), 0, 1, Some("first-listen".into())));
        let mut rows = registry.tab_index("main");
        assert_eq!(rows.len(), 1);
        let row = rows.pop().unwrap();
        assert!(row.workspaces.is_empty());
        let wire = serde_json::to_value(row).unwrap();
        assert_eq!(wire["account_management_ready"], json!(true));
        let restored: WindowTabIndex = serde_json::from_value(wire).unwrap();
        assert!(restored.account_management_ready);
        assert_eq!(restored.account_management_subscription, Some(WindowAccountManagementSubscription {
            publication_id: first.clone(), subscription_id: "first-listen".into(),
        }));
        assert_eq!(restored.window_label, label);
        assert!(registry.fragment(label).is_none());
        assert!(registry.tab_index(label).is_empty());

        assert!(registry.publish_live_fragment(fragment(label, &["peer"]), Some(&first)));
        assert!(registry.tab_index("main")[0].account_management_ready);
        registry.set_close_intent(label, true);
        assert!(!registry.tab_index("main")[0].account_management_ready);
        registry.set_close_intent(label, false);
        assert!(registry.tab_index("main")[0].account_management_ready);
        assert!(registry.set_account_management_ready(label, Some(&first), 0, 2, None));
        assert!(!registry.tab_index("main")[0].account_management_ready);

        registry.unregister_fragment_publisher(label);
        registry.forget_window(label);
        let second = registry.register_fragment_publisher(label);
        assert!(!registry.set_account_management_ready(label, Some(&first), 0, 1, Some("first-listen".into())));
        assert!(registry.tab_index("main").is_empty());
        assert!(registry.set_account_management_ready(label, Some(&second), 0, 1, Some("second-listen".into())));
        assert!(registry.tab_index("main")[0].account_management_ready);
    }

    #[test]
    fn account_management_rejects_a_delayed_close_intent_after_label_reuse() {
        let registry = WindowRegistry::new();
        let label = "mycmux-w1";
        let first = registry.register_fragment_publisher(label);
        assert!(registry.publish_live_fragment(fragment(label, &["old"]), Some(&first)));
        let delayed_intent = || registry.set_publisher_close_intent(label, Some(&first), true);

        registry.unregister_fragment_publisher(label);
        registry.forget_window(label);
        let successor = registry.register_fragment_publisher(label);
        assert!(registry.publish_live_fragment(fragment(label, &["successor"]), Some(&successor)));
        assert!(registry.set_account_management_ready(label, Some(&successor), 0, 1, Some("successor-listen".into())));

        let late_result = delayed_intent();
        assert!(registry.tab_index("main")[0].account_management_ready);
        assert!(registry.publish_live_fragment(fragment(label, &["still-live"]), Some(&successor)));
        assert!(!late_result);

        assert!(registry.set_publisher_close_intent(label, Some(&successor), true));
        assert!(!registry.set_publisher_close_intent(label, Some(&first), false));
        assert!(!registry.tab_index("main")[0].account_management_ready);
        assert!(registry.set_publisher_close_intent(label, Some(&successor), false));
        assert!(registry.tab_index("main")[0].account_management_ready);
    }

    #[test]
    fn account_management_ignores_older_publications_and_subscriptions() {
        let registry = WindowRegistry::new();
        let label = "mycmux-w1";
        let publication = registry.register_fragment_publisher(label);
        let update = |sequence, subscription_id: Option<&str>| {
            assert!(registry.set_account_management_ready(
                label, Some(&publication), 0, sequence, subscription_id.map(str::to_owned),
            ));
        };
        update(2, None);
        update(1, Some("removed-listen"));
        assert!(registry.tab_index("main").is_empty());
        update(3, Some("current-listen"));
        update(3, Some("duplicate-sequence"));
        update(2, None);
        let index = registry.tab_index("main");
        assert_eq!(index[0].account_management_subscription.as_ref().unwrap().subscription_id, "current-listen");
    }

    #[test]
    fn legacy_settings_flag_does_not_change_workspace_fragments() {
        let legacy = json!({
            "window_label": "mycmux-w1",
            "workspaces": [{
                "id": "peer",
                "name": "Peer",
                "grid_template_id": "1x1",
                "created_at": 0,
                "panes": [],
                "window_group": { "label": "mycmux-w1", "active_workspace_id": "peer" },
            }],
            "active_workspace_id": "peer",
            "active_pane_id": "pane",
            "active_tab_id": "tab",
        });
        let mut with_settings_flag = legacy.clone();
        with_settings_flag["settings_available"] = json!(true);
        let decode = |value| serde_json::from_value::<WindowFragment>(value).unwrap();
        let decoded = serde_json::to_value(decode(with_settings_flag)).unwrap();

        assert!(decoded.get("settings_available").is_none());
        assert_eq!(decoded, serde_json::to_value(decode(legacy.clone())).unwrap());
        for key in ["window_label", "workspaces", "active_workspace_id", "active_pane_id", "active_tab_id"] {
            assert_eq!(decoded[key], legacy[key]);
        }
    }

    #[test]
    fn dashboard_tab_index_copies_only_display_fields_and_first_command_argument() {
        let registry = WindowRegistry::new();
        let source = json!({ "id": "ws", "name": "Research", "declared_prompt": "secret",
            "panes": [{ "pane_id": "pane", "agent_id": "codex",
                "tabs": [{ "tab_id": "tab", "session_id": "session", "agent_id": "codex", "label": "Label", "label_source": "ai",
                    "display_name": "Name", "display_name_source": "auto", "type": "web", "preset_id": "chatgpt", "cwd": "/work",
                    "agent_kind": "codex", "agent_session_id": "conversation", "claude_session_id": null,
                    "source_kind": "pdf", "source_path": "/read.pdf", "commandArgv": ["codex", "secret"],
                    "launch_env": { "MYCMUX_LAUNCH_TARGET": "mac", "SECRET": "secret" },
                    "lifecycle": "declared", "delegated_by_tab_id": "parent", "delegated_by_agent_session_id": "parent-session", "delegated_at": 1,
                    "terminal_snapshot": ["secret"], "turn_marks": ["secret"], "declared_prompt": "secret", "suppressed_agent_sessions": ["secret"]
                }] }] });
        registry.publish_fragment(WindowFragment {
            window_label: "mycmux-w1".into(),
            workspaces: vec![source],
            ..Default::default()
        });
        let value = serde_json::to_value(registry.tab_index("main")).unwrap();
        let tab = &value[0]["workspaces"][0]["panes"][0]["tabs"][0];
        assert_eq!(tab["command_argv"], json!(["codex"]));
        assert_eq!(tab["launch_env"], json!({ "MYCMUX_LAUNCH_TARGET": "mac" }));
        assert_eq!(tab["display_name_source"], "auto");
        assert_eq!(value[0]["workspaces"][0]["panes"][0]["id"], "pane");
        let allowed = [
            "tab_id",
            "session_id",
            "agent_id",
            "label",
            "label_source",
            "display_name",
            "display_name_source",
            "type",
            "preset_id",
            "cwd",
            "agent_kind",
            "agent_session_id",
            "claude_session_id",
            "source_kind",
            "source_path",
            "command_argv",
            "launch_env",
            "pty_alive",
            "live_agent_kind",
            "lifecycle",
            "delegated_by_tab_id",
            "delegated_by_agent_session_id",
            "delegated_at",
        ];
        assert!(tab
            .as_object()
            .unwrap()
            .keys()
            .all(|key| allowed.contains(&key.as_str())));
        assert!(!value.to_string().contains("secret"));
    }

    fn workspace(id: &str) -> Value {
        json!({ "id": id, "name": id, "panes": [] })
    }

    fn fragment(label: &str, ids: &[&str]) -> WindowFragment {
        WindowFragment {
            window_label: label.to_string(),
            pending: false,
            workspaces: ids.iter().map(|id| workspace(id)).collect(),
            active_workspace_id: ids.first().map(|id| id.to_string()),
            active_pane_id: None,
            active_tab_id: None,
        }
    }

    #[test]
    fn adoption_round_trips_and_drains_once() {
        let registry = WindowRegistry::new();
        registry.queue_adoption("mycmux-w1", vec![workspace("ws-a"), workspace("ws-b")]);

        assert_eq!(registry.pending_adoption_len("mycmux-w1"), 2);
        assert_eq!(
            registry.window_for_workspace("ws-a").as_deref(),
            Some("mycmux-w1")
        );

        let adopted = registry.take_pending_adoption("mycmux-w1");
        assert_eq!(workspace_config_ids(&adopted), vec!["ws-a", "ws-b"]);
        // Draining is the commit point: a duplicate adopt event gets nothing.
        assert!(registry.take_pending_adoption("mycmux-w1").is_empty());
    }

    #[test]
    fn publishing_a_fragment_re_derives_ownership() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a", "ws-b"]));
        assert_eq!(registry.workspaces_assigned_to("mycmux-w1"), ["ws-a", "ws-b"]);

        // ws-b left the window: its assignment must not linger.
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a"]));
        assert_eq!(registry.workspaces_assigned_to("mycmux-w1"), ["ws-a"]);
        assert_eq!(registry.window_for_workspace("ws-b"), None);
    }

    #[test]
    fn publishing_never_disturbs_another_windows_assignments() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("main", &["ws-main"]));
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a"]));

        assert_eq!(
            registry.window_for_workspace("ws-main").as_deref(),
            Some("main")
        );
        assert_eq!(
            registry.window_for_workspace("ws-a").as_deref(),
            Some("mycmux-w1")
        );
    }

    #[test]
    fn fragments_are_returned_in_stable_label_order() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("mycmux-w2", &["ws-c"]));
        registry.publish_fragment(fragment("main", &["ws-a"]));
        registry.publish_fragment(fragment("mycmux-w1", &["ws-b"]));

        let labels: Vec<String> = registry
            .fragments()
            .into_iter()
            .map(|fragment| fragment.window_label)
            .collect();
        assert_eq!(labels, ["main", "mycmux-w1", "mycmux-w2"]);
    }

    #[test]
    fn release_moves_only_the_named_workspaces() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a", "ws-b"]));

        let moved = registry.release_workspaces("mycmux-w1", &["ws-b".to_string()], "main");
        assert_eq!(workspace_config_ids(&moved), vec!["ws-b"]);

        let remaining = registry.fragment("mycmux-w1").unwrap();
        assert_eq!(workspace_config_ids(&remaining.workspaces), vec!["ws-a"]);
        assert_eq!(
            workspace_config_ids(&registry.take_pending_adoption("main")),
            vec!["ws-b"]
        );
        assert_eq!(registry.window_for_workspace("ws-b").as_deref(), Some("main"));
    }

    #[test]
    fn releasing_an_unpublished_workspace_moves_nothing() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a"]));

        let moved = registry.release_workspaces("mycmux-w1", &["ws-ghost".to_string()], "main");
        assert!(moved.is_empty());
        assert!(registry.take_pending_adoption("main").is_empty());
    }

    #[test]
    fn release_all_covers_the_crash_path() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a", "ws-b"]));

        let moved = registry.release_all("mycmux-w1", "main");
        assert_eq!(workspace_config_ids(&moved), vec!["ws-a", "ws-b"]);
        assert!(registry.fragment("mycmux-w1").unwrap().workspaces.is_empty());
        assert_eq!(
            workspace_config_ids(&registry.take_pending_adoption("main")),
            vec!["ws-a", "ws-b"]
        );
    }

    #[test]
    fn l3_78_reusing_and_closing_a_label_does_not_release_an_old_crash_hold() {
        let registry = WindowRegistry::new();
        let label = "mycmux-w1";
        registry.hold_startup_workspaces([("old", Some(label))].into_iter());
        registry.queue_adoption(label, vec![workspace("old")]);
        registry.take_pending_adoption(label); // Before first publish.
        registry.forget_window(label);
        assert!(registry.held_workspace_ids().contains("old"));
        registry.queue_adoption(label, vec![workspace("new")]);
        registry.forget_closed_window(label);
        assert_eq!(registry.held_workspace_ids(), std::collections::HashSet::from(["old".into()]));
    }

    #[test]
    fn l3_fix2_10_a_failed_or_cancelled_window_creation_cannot_claim_a_reused_label() {
        let registry = WindowRegistry::new();
        let label = "mycmux-w1";
        let first = registry.track_workspace_window(label, "first".into(), "main".into());
        assert!(registry.matches_workspace_window(label, "first", "main"));
        registry.cancel_workspace_window(label, "first", "main");
        assert!(!first.load(Ordering::Acquire));
        registry.forget_window(label);
        let next = registry.track_workspace_window(label, "successor".into(), "main".into());
        registry.cancel_workspace_window(label, "first", "main");
        assert!(next.load(Ordering::Acquire));
        assert!(!registry.matches_workspace_window(label, "first", "main"));
        assert!(!registry.matches_workspace_window(label, "successor", "other"));
        assert!(registry.matches_workspace_window(label, "successor", "main"));
    }

    #[test]
    fn l3_75_recovered_startup_adoption_marks_the_workspace_identity_to_keep() {
        let registry = WindowRegistry::new();
        let label = "mycmux-w1";
        registry.hold_startup_workspaces([("startup", Some(label))].into_iter());
        registry.queue_adoption(label, vec![workspace("startup")]);
        registry.release_all(label, "main");
        let rescued = registry.take_pending_adoption("main");
        assert_eq!(rescued[0]["preserve_workspace_identity"], true);
    }

    #[test]
    fn release_all_rescues_an_adoption_that_was_never_picked_up() {
        // Child died between open_workspace_window and its boot handshake.
        let registry = WindowRegistry::new();
        registry.queue_adoption("mycmux-w1", vec![workspace("ws-a")]);

        let moved = registry.release_all("mycmux-w1", "main");
        assert_eq!(workspace_config_ids(&moved), vec!["ws-a"]);
        assert_eq!(
            workspace_config_ids(&registry.take_pending_adoption("main")),
            vec!["ws-a"]
        );
    }

    #[test]
    fn release_all_after_a_clean_merge_back_is_a_no_op() {
        // The close handler already released; the Destroyed hook must not
        // double-queue the same workspaces.
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a"]));
        registry.release_workspaces("mycmux-w1", &["ws-a".to_string()], "main");
        assert_eq!(registry.take_pending_adoption("main").len(), 1);

        assert!(registry.release_all("mycmux-w1", "main").is_empty());
        assert!(registry.take_pending_adoption("main").is_empty());
    }

    #[test]
    fn l3_fix3_13_a_delayed_fragment_cannot_revive_a_destroyed_window() {
        let registry = WindowRegistry::new();
        let old = fragment("mycmux-w1", &["closed"]);
        let first = registry.register_fragment_publisher("mycmux-w1");
        assert!(registry.publish_live_fragment(old.clone(), Some(&first)));
        registry.set_close_intent("mycmux-w1", true);
        registry.unregister_fragment_publisher("mycmux-w1");
        assert!(registry.take_close_intent("mycmux-w1"));
        registry.forget_closed_window("mycmux-w1");

        assert!(!registry.publish_live_fragment(old.clone(), Some(&first)));
        assert!(registry.fragment("mycmux-w1").is_none());
        let second = registry.register_fragment_publisher("mycmux-w1");
        assert!(registry.publish_live_fragment(fragment("mycmux-w1", &["successor"]), Some(&second)));
        assert!(!registry.publish_live_fragment(old, Some(&first)));
        assert_eq!(registry.window_for_workspace("successor").as_deref(), Some("mycmux-w1"));
        assert!(registry.window_for_workspace("closed").is_none());
    }

    #[test]
    fn forget_window_clears_every_index() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a"]));
        registry.queue_adoption("mycmux-w1", vec![workspace("ws-b")]);

        registry.forget_window("mycmux-w1");
        assert!(registry.fragment("mycmux-w1").is_none());
        assert_eq!(registry.pending_adoption_len("mycmux-w1"), 0);
        assert!(registry.workspaces_assigned_to("mycmux-w1").is_empty());
        assert!(registry.known_windows().is_empty());
    }

    #[test]
    fn orphan_windows_ignores_main_and_live_windows() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(fragment("main", &["ws-main"]));
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a"]));
        registry.publish_fragment(fragment("mycmux-w2", &["ws-b"]));

        let live = vec!["main".to_string(), "mycmux-w1".to_string()];
        assert_eq!(registry.orphan_windows(&live), ["mycmux-w2"]);
    }

    #[test]
    fn revision_advances_on_every_mutation() {
        let registry = WindowRegistry::new();
        let start = registry.revision();
        registry.publish_fragment(fragment("mycmux-w1", &["ws-a"]));
        let after_publish = registry.revision();
        registry.release_workspaces("mycmux-w1", &["ws-a".to_string()], "main");

        assert!(after_publish > start);
        assert!(registry.revision() > after_publish);
    }

    #[test]
    fn workspaces_without_an_id_are_ignored_by_the_index() {
        let registry = WindowRegistry::new();
        registry.publish_fragment(WindowFragment {
            window_label: "mycmux-w1".to_string(),
            workspaces: vec![serde_json::json!({ "name": "no id" }), workspace("ws-a")],
            ..Default::default()
        });

        assert_eq!(registry.workspaces_assigned_to("mycmux-w1"), ["ws-a"]);
        // The malformed entry still round-trips inside the fragment so main's
        // union merge does not silently drop it from data.json.
        assert_eq!(registry.fragment("mycmux-w1").unwrap().workspaces.len(), 2);
    }
}

#[cfg(test)]
mod leader_tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn owner_is_idempotent_and_only_owner_can_release() {
        let registry = WindowRegistry::new();
        assert!(registry.claim_leader("main"));
        assert!(registry.claim_leader("main"));
        assert!(!registry.claim_leader("mycmux-w1"));
        assert!(!registry.release_leader("mycmux-w1"));
        assert_eq!(registry.leader().as_deref(), Some("main"));
        assert!(registry.release_leader("main"));
        assert!(registry.claim_leader("mycmux-w1"));
        assert!(!registry.claim_leader("main"));
    }

    #[test]
    fn destroyed_owner_can_be_replaced_by_exactly_one_concurrent_executor() {
        let registry = Arc::new(WindowRegistry::new());
        assert!(registry.claim_leader("main"));
        registry.release_leader("main");
        let barrier = Arc::new(Barrier::new(16));
        let handles: Vec<_> = (1..=16).map(|i| {
            let registry = registry.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                registry.claim_leader(&format!("mycmux-w{i}"))
            })
        }).collect();
        let winners = handles.into_iter().filter_map(|h| h.join().ok()).filter(|won| *won).count();
        assert_eq!(winners, 1);
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn cleanup_waits_for_the_last_window_and_runs_once() {
        let registry = WindowRegistry::new();
        for live in [3, 2, 1] { assert!(!registry.begin_shutdown(live, None)); }
        assert!(registry.begin_shutdown(0, None));
        assert!(!registry.begin_shutdown(0, None));
    }

    #[test]
    fn programmatic_exit_and_updater_restart_clean_up_with_live_windows_once() {
        for code in [0, i32::MAX] { // Tauri RESTART_EXIT_CODE is i32::MAX.
            let registry = WindowRegistry::new();
            assert!(!registry.begin_shutdown(2, None));
            assert!(registry.begin_shutdown(2, Some(code)));
            assert!(!registry.begin_shutdown(2, Some(code)));
            assert!(!registry.begin_shutdown(0, None));
            assert!(!registry.begin_shutdown(0, Some(0))); // Subsequent RunEvent::Exit.
        }
    }

    #[test]
    fn concurrent_final_exit_requests_only_claim_cleanup_once() {
        let registry = Arc::new(WindowRegistry::new());
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|_| {
            let registry = registry.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); registry.begin_shutdown(0, None) })
        }).collect();
        assert_eq!(threads.into_iter().map(|thread| thread.join().unwrap()).filter(|winner| *winner).count(), 1);
    }

    #[test]
    fn crash_rescue_prefers_a_live_role_owner_and_never_requires_main() {
        let registry = WindowRegistry::new();
        let live = vec!["mycmux-w1".to_string(), "mycmux-w2".to_string()];
        registry.claim_leader("mycmux-w2");
        assert_eq!(registry.rescue_target("main", &live).as_deref(), Some("mycmux-w2"));
        registry.set_close_intent("mycmux-w2", true);
        assert_eq!(registry.rescue_target("main", &live).as_deref(), Some("mycmux-w1"));
        assert_eq!(registry.rescue_target("mycmux-w1", &live), None);
        assert!(registry.take_close_intent("mycmux-w2"));
        assert!(!registry.take_close_intent("mycmux-w2"));
        assert!(!registry.take_close_intent("main"));
    }

    #[test]
    fn a_crash_handoff_preserves_published_and_pending_session_ids() {
        let registry = WindowRegistry::new();
        let config = serde_json::json!({"id":"crashed", "panes":[{"tabs":[{"session_id":"live-pty"}]}]});
        registry.queue_adoption("main", vec![config.clone()]);
        registry.release_all("main", "mycmux-w2");
        registry.forget_window("main");
        assert_eq!(registry.take_pending_adoption("mycmux-w2"), vec![config]);
        assert_eq!(registry.window_for_workspace("crashed").as_deref(), Some("mycmux-w2"));
    }
}
