# Agent System

## Overview

An "agent" is a command definition that determines what process runs in a terminal pane. Each pane tab has an `agentId` that maps to an `AgentDefinition`.

## Built-in Agents

| ID | Name | Command | Icon | Color |
|----|------|---------|------|-------|
| `shell` | Shell | `/bin/bash` | `$` | `#a6e3a1` |
| `claude-code` | Claude Code | `claude` | `C` | `#89b4fa` |
| `codex` | Codex CLI | `codex` | `X` | `#f5c2e7` |
| `gemini` | Gemini CLI | `gemini` | `G` | `#f9e2af` |
| `aider` | Aider | `aider` | `A` | `#94e2d5` |

Defined in `src/lib/agents.ts`.

## AgentDefinition Type

```typescript
interface AgentDefinition {
  id: string;          // unique identifier
  name: string;        // display name
  description: string; // shown in UI
  command: string;     // shell command to launch
  args: string[];      // command arguments
  icon: string;        // single char icon
  color: string;       // hex color for pane header accent
}
```

## How Agents Are Used

1. **Workspace creation**: `AgentSelector` + `AgentSlotList` let users assign agents to each pane slot
2. **Tab creation**: `addTabToPane(workspaceId, paneId, agentId)` — agent determines the command spawned
3. **PTY spawn**: `XTermWrapper` receives `command` and `args` from the agent definition
4. **Default**: `getDefaultAgent()` returns `shell` (first in BUILT_IN_AGENTS array)

## Agent Resolution

```typescript
const agent = getAgent(tab.agentId) ?? getDefaultAgent();
// agent.command → passed to createSession()
// agent.args → passed to createSession()
```

If an agent ID doesn't match any built-in, falls back to shell.

## Adding New Agents

Add an entry to `BUILT_IN_AGENTS` array in `src/lib/agents.ts`. No other changes needed — the agent appears in `AgentSelector` automatically.

## Future

Custom user-defined agents (JSON config) are not yet implemented. Currently only the 5 built-in agents are available.

## Session Resume (v0.4.0 廃止 → v0.5.6 再導入)

Claude Code / Codex / claude-codex は過去のセッションを CRSM Palette (`Ctrl+P`) から手動で resume できるほか、v0.5.6 以降は再起動時の自動 resume も正式機能として復活している。自動 resume は v0.4.0 で env 汚染事故を受けて一時廃止 → v0.5.6 で多層安全弁とセットに再導入。live セッション検出は `pty/monitor.rs`、再起動時の注入は `TerminalPane.tsx` が担い、CRSM Palette 経由の手動 resume と併存する。詳細は [search-and-command-palette.md](./search-and-command-palette.md) を参照。

### Env Hygiene

CRSM 経由で resume を起動する際、ランチャは `MYCMUX_RESUME=1` / `MYCMUX_*` / `__CMUX_LAUNCHER_DONE` を **対象ペインのみ** に渡す。アプリ起動時に `lib.rs` でこれらを `std::env::remove_var()` で除去するため、新規ペインに env が漏れない。新規ペインで `Get-ChildItem env: | Where-Object Name -like 'MYCMUX*'` を実行して空であることが正常状態。
