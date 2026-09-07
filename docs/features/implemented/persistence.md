# Persistence

## Storage Location

`$APP_DATA_DIR/data.json` — resolved via Tauri's `app_data_dir()`.

Windows: `%APPDATA%/com.miyazaki.mycmux/data.json`; macOS: `~/Library/Application Support/com.miyazaki.mycmux/data.json`.

## Data Shape (abridged)

```json
{
  "schema_version": 1,
  "workspaces": [
    {
      "id": "uuid",
      "name": "Terminal",
      "grid_template_id": "2x1",
      "panes": [
        { "agent_id": "shell", "label": null, "cwd": null },
        { "agent_id": "shell-starter", "label": null, "cwd": null }
      ],
      "created_at": 1773924000000
    }
  ],
  "settings": {
    "font_size": 14,
    "theme_id": "mayonaka"
  }
}
```

## What Persists

| Data | Persisted | Why |
|------|-----------|-----|
| Workspace list (name, grid, color) | Yes | Restore layout on relaunch |
| Pane agent assignments | Yes | Remember which agent per slot |
| Theme ID + font size | Yes | User preferences |
| PTY sessions / processes | No across app exit | Existing in-app sessions reattach; restart spawns processes and restores validated agent identities |
| Terminal scrollback / content | Yes, snapshots | `terminal_snapshot` in saved tabs plus the PTY scrollback store |
| Notification counts | No | Runtime-only metadata |
| Active workspace / pane / tab | Yes | Saved selection IDs restore the active location |
| Window position / size | Yes | Restored by `tauri-plugin-window-state` |
| CWD / git branch | CWD only | CWD is saved for relaunch; git branch is polled from live processes |
| `agent_session_id` / `agent_kind` / `claude_session_id` | **Yes (v0.5.6 で再導入)** | v0.4.0 で env 汚染事故を受けて一時廃止したが、多層安全弁 (`sanitize_launch_env` / `EPHEMERAL_LAUNCH_ENV_KEYS` / `lib.rs` の `remove_var` / `dedupeAgentSessionsInConfigs`) とセットに再導入し、resume-on-restart を実現 |

### Migration Note

v0.3.x までの `data.json` には `panes[].agent_session_id` 等が保存されていた可能性がある。v0.4.0 では一時的にこれらのフィールドを `#[serde(default)]` で受け流し、次回保存時に黙って削除していたが、v0.5.6 (`5620c11e`, "feat(persistence): restore session-history persistence on restart") で多層安全弁とセットに再導入し、以降は正式に保存・resume に利用する。旧 v0.3.x 由来の値が残っていても実体検証 (`validate_agent_restore_request` / `can_restore_agent_session`) で無効な参照は弾かれるため、追加のマイグレーション処理は不要。

## Save Flow

```
SocketListener subscribes to persistent store changes (leader window)
  → mark dirty → 500ms debounce → serialize workspaces, settings, selection
    → savePersistentData(snapshot) IPC call
      → Rust: validate schema → backup → atomic replacement of data.json
```

Saves are **dirty-triggered and debounced by 500ms**, serialized through the persistence coordinator; volatile output metadata does not reset the save timer. File size depends on layouts and saved snapshots.

## Load Flow

```
SocketListener (leader startup; child windows hydrate separately)
  → loadPersistentData() IPC call
    → Rust: read data.json → return PersistentDataEnvelope
  → if supported data and saved workspaces exist:
    → restore workspaces and pane/tab identities from saved configs
    → restore active workspace / pane / tab selection
```

Startup hydration is guarded in `SocketListener`; unsupported schemas quarantine persistence instead of being overwritten.

## Error Handling

- Load failure: logged to console, app starts with empty workspace
- Save failure: logged; the serialized save coordinator retains dirty state and schedules retries where allowed
- Missing file: restores a valid pre-replace backup when available; otherwise uses `PersistentData::default()`
- Empty/corrupt file: recovers a valid pre-replace backup or quarantines the file before defaults; unsupported schemas are reported without overwriting them
