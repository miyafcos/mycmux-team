# Persistence

## Storage Location

`$APP_DATA_DIR/data.json` — resolved via Tauri's `app_data_dir()`.

On Linux: `~/.local/share/com.ptrterminal.app/data.json`

## Data Shape

```json
{
  "workspaces": [
    {
      "id": "uuid",
      "name": "Terminal",
      "grid_template_id": "2x1",
      "panes": [
        { "agent_id": "shell", "label": null },
        { "agent_id": "claude-code", "label": null }
      ],
      "created_at": 1773924000000
    }
  ],
  "settings": {
    "font_size": 14,
    "theme_id": "midnight"
  }
}
```

## What Persists

| Data | Persisted | Why |
|------|-----------|-----|
| Workspace list (name, grid, color) | Yes | Restore layout on relaunch |
| Pane agent assignments | Yes | Remember which agent per slot |
| Theme ID + font size | Yes | User preferences |
| PTY sessions / processes | No | Spawned fresh on mount |
| Terminal scrollback / content | No | Volatile per session |
| Notification counts | No | Runtime-only metadata |
| Active workspace / pane | No | Defaults to last workspace |
| Window position / size | Yes | Restored by `tauri-plugin-window-state` |
| CWD / git branch | No | Polled from live processes |
| `agent_session_id` / `agent_kind` / `claude_session_id` | **Yes (v0.5.6 で再導入)** | v0.4.0 で env 汚染事故を受けて一時廃止したが、多層安全弁 (`sanitize_launch_env` / `EPHEMERAL_LAUNCH_ENV_KEYS` / `lib.rs` の `remove_var` / `dedupeAgentSessionsInConfigs`) とセットに再導入し、resume-on-restart を実現 |

### Migration Note

v0.3.x までの `data.json` には `panes[].agent_session_id` 等が保存されていた可能性がある。v0.4.0 では一時的にこれらのフィールドを `#[serde(default)]` で受け流し、次回保存時に黙って削除していたが、v0.5.6 (`77f576d`, "feat(persistence): restore session-history persistence on restart") で多層安全弁とセットに再導入し、以降は正式に保存・resume に利用する。旧 v0.3.x 由来の値が残っていても実体検証 (`validate_agent_restore_request` / `can_restore_agent_session`) で無効な参照は弾かれるため、追加のマイグレーション処理は不要。

## Save Flow

```
workspaceStore.subscribe() triggers on any state change
  → map each Workspace → WorkspaceConfig (id, name, grid_template_id, panes, created_at)
    → saveWorkspaces(configs) IPC call
      → Rust: load existing data.json → replace workspaces field → write back
```

Saves happen on **every workspace store change** — no debounce. The JSON file is small (<1KB typically).

## Load Flow

```
useWorkspacePersist hook (on mount, once)
  → loadPersistentData() IPC call
    → Rust: read data.json → deserialize → return PersistentData
  → if workspaces exist:
    → createWorkspace() for each saved config
    → removeWorkspace(bootstrap) to replace initial empty workspace
```

The hook uses a `loaded` ref to ensure single execution.

## Error Handling

- Load failure: logged to console, app starts with empty workspace
- Save failure: logged to console, no retry
- Missing file: returns `PersistentData::default()` (empty workspaces, default settings)
- Parse error: returns error string, caught by JS
