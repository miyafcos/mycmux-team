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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

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
    leader: std::sync::Mutex<Option<String>>,
    closing: std::sync::Mutex<std::collections::HashSet<String>>,
    shutdown_started: AtomicBool,
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self::default()
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

    /// Ids some live window still holds: what it published, plus what is
    /// queued for a window that has not adopted it yet.
    ///
    /// Only the ids, because the save path asks this on every write and the
    /// values are whole workspaces.
    pub fn held_workspace_ids(&self) -> std::collections::HashSet<String> {
        let mut ids = std::collections::HashSet::new();
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
