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
//!                   disappears from `data.json` (which the phone remote reads
//!                   for workspace names),
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
use std::sync::atomic::{AtomicU64, Ordering};

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

#[derive(Default)]
pub struct WindowRegistry {
    assignments: DashMap<String, String>,
    fragments: DashMap<String, WindowFragment>,
    pending_adoptions: DashMap<String, Vec<Value>>,
    revision: AtomicU64,
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self::default()
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
        for workspace_id in workspace_ids {
            self.assignments
                .insert(workspace_id.clone(), label.to_string());
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

    /// Store a window's latest view and re-derive ownership from it. Ownership
    /// is re-derived (rather than merged) so a workspace that left this window
    /// stops being attributed to it even if the move itself was lost.
    pub fn publish_fragment(&self, fragment: WindowFragment) {
        let label = fragment.window_label.clone();
        let workspace_ids = workspace_config_ids(&fragment.workspaces);
        let published: std::collections::HashSet<&String> = workspace_ids.iter().collect();

        self.assignments.retain(|workspace_id, owner| {
            owner != &label || published.contains(workspace_id)
        });
        for workspace_id in &workspace_ids {
            self.assignments
                .insert(workspace_id.clone(), label.clone());
        }
        self.fragments.insert(label, fragment);
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

    /// Move workspaces from one window to another: they leave the source
    /// fragment and land in the target's adoption queue. Returns what actually
    /// moved (a workspace the source never published cannot move).
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
            let pending = self.take_pending_adoption(from_label);
            if !pending.is_empty() {
                self.queue_adoption(to_label, pending.clone());
            }
            return pending;
        }
        let mut moved = self.release_workspaces(from_label, &ids, to_label);
        let pending = self.take_pending_adoption(from_label);
        if !pending.is_empty() {
            self.queue_adoption(to_label, pending.clone());
            moved.extend(pending);
        }
        moved
    }

    /// Drop everything the registry knows about a window. Call only after its
    /// workspaces have been released, or they are lost.
    pub fn forget_window(&self, label: &str) {
        self.fragments.remove(label);
        self.pending_adoptions.remove(label);
        self.assignments.retain(|_, owner| owner != label);
        self.bump();
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
    /// `app.webview_windows()`), excluding main itself.
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
