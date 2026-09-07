# Agent System

## Overview

An "agent" is a command definition that determines what process runs in a terminal pane. Each pane tab has an `agentId` that maps to an `AgentDefinition`.

## Built-in Agent Definitions (including legacy entries)

| ID | Name | Command | Icon | Color |
|----|------|---------|------|-------|
| `shell-starter` | Launch Menu | Detected shell + launcher dispatch | `>` | `#f9e2af` |
| `shell` | Shell | Detected system shell | `$` | `#a6e3a1` |
| `claude-code` | Claude Code | `claude` | `C` | `#89b4fa` |
| `codex` | Codex CLI | `codex --no-alt-screen` | `X` | `#f5c2e7` |
| `grok` | Grok Build | `grok --no-alt-screen` | `K` | `#f38ba8` |
| `gemini` | Gemini CLI | `gemini` | `G` | `#f9e2af` |
| `aider` | Aider | `aider` | `A` | `#94e2d5` |

Defined in `src/lib/agents.ts`; `gemini` and `aider` remain legacy definitions, not supported launcher choices.
The launch catalog tracks `claude` / `codex` / `claude-codex` / `grok`, plus untracked `agy`; `claude-codex-open` selects the open backend.
New tabs use the React `LauncherPane` (v0.62.0); its directory sections are configured in Settings → Launcher (v0.64.0), and its five Web services are listed in `agentCatalog.ts`.

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

1. **Workspace creation**: `AgentSelector` + `AgentSlotList` let users pick a launch spec (agent, model, effort) per pane slot. Those come from `src/lib/agentCatalog.ts`, not from `BUILT_IN_AGENTS` — everything but a plain shell starts through the launcher via `MYCMUX_LAUNCH_TARGET`
2. **Tab creation**: `addTabToPane(workspaceId, paneId, agentId)` — agent determines the command spawned
3. **PTY spawn**: `XTermWrapper` receives `command` and `args` from the agent definition
4. **Default**: `getDefaultAgent()` returns `shell-starter` (first in BUILT_IN_AGENTS array)

## Agent Resolution

```typescript
const agent = getAgent(tab.agentId) ?? getDefaultAgent();
// agent.command → passed to createSession()
// agent.args → passed to createSession()
```

If an agent ID doesn't match any built-in, falls back to `shell-starter`.

## Adding New Agents

`BUILT_IN_AGENTS` (`src/lib/agents.ts`) retains direct PTY definitions, including
legacy entries. Supported launcher choices live in
`src/lib/agentCatalog.ts` and are started by the launcher, so adding one means:

1. the launcher menu row, its `$LaunchTargets` / `MYCMUX_LAUNCH_TARGET` case, and
   its entry in the row-to-target mapping (`New-MycmuxOption`'s fourth argument /
   the `spec_targets` array) in **both** `src-tauri/src/launcher.ps1` and
   `launcher.sh`
2. an entry in `AGENT_CATALOG` with the same `target` and `label`, its `cli`,
   and the model / effort choices it accepts
3. if the CLI takes a model or an effort: a translation arm
   (`Add-MycmuxLaunchSpecToCommandArray` / `__add_launch_spec_to_cmd`) and the
   choices the launcher's own model menu offers (`$LaunchSpecCatalog` /
   `__spec_models_for`, `__spec_efforts_for`, `__spec_has_target`) — in both

`tests/test_launcher_catalog_contract.py` fails when any of the three is
missing, and also runs both launchers over the same input to check they produce
the same command line. The full new-agent checklist is in
`docs/agent-integration.md`.

## Future

Custom user-defined agents (JSON config) are not yet implemented.

## Session Resume (v0.4.0 廃止 → v0.5.6 再導入)

Claude Code / Codex / claude-codex は過去のセッションを CRSM Palette (`Ctrl+P`) から手動で resume できるほか、v0.5.6 以降は再起動時の自動 resume も正式機能として復活している。自動 resume は v0.4.0 で env 汚染事故を受けて一時廃止 → v0.5.6 で多層安全弁とセットに再導入。live セッション検出は `pty/monitor.rs`、再起動時の注入は `TerminalPane.tsx` が担い、CRSM Palette 経由の手動 resume と併存する。詳細は [search-and-command-palette.md](./search-and-command-palette.md) を参照。

### Env Hygiene

CRSM 経由で resume を起動する際、ランチャは `MYCMUX_RESUME=<agent-kind>` / `MYCMUX_SESSION_ID` を **対象ペインのみ** に渡す。アプリ起動時に `lib.rs` でこれらを `std::env::remove_var()` で除去するため、新規ペインに env が漏れない。新規ペインにも識別用の `MYCMUX_TERM_PROGRAM` 等は存在する。除去対象は起動・resume 用の一時変数であり、`MYCMUX_*` 全体が空になるわけではない。
