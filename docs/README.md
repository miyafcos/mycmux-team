# mycmux Documentation

AI agent terminal workspace built with Tauri v2 + React + xterm.js.

## Navigation

- [current-state.md](current-state.md) — Current checkout facts, install paths, build/verification flow, and session handoff notes

### Infrastructure
- [stack.md](infrastructure/stack.md) — Tech stack with versions & rationale
- [architecture.md](infrastructure/architecture.md) — Process model, module map, state ownership
- [data-flow.md](infrastructure/data-flow.md) — Input/output/resize/persistence data paths
- [rust-backend.md](infrastructure/rust-backend.md) — All Rust modules, commands, types
- [frontend-structure.md](infrastructure/frontend-structure.md) — Component tree, stores, hooks, types
- [build-and-dev.md](infrastructure/build-and-dev.md) — Dev commands, Vite/Tauri config, env vars

### Design
- [overview.md](design/overview.md) — Design philosophy, visual identity, principles
- [theme-system.md](design/theme-system.md) — ThemeDefinition structure, 30 themes, how to add
- [colors-and-tokens.md](design/colors-and-tokens.md) — CSS custom properties, opacity scale, semantic usage
- [typography-and-spacing.md](design/typography-and-spacing.md) — Font stacks, type scale, spacing constants
- [component-patterns.md](design/component-patterns.md) — Pill, button, tab, pane, sidebar, grid patterns
- [animations-and-states.md](design/animations-and-states.md) — Transitions, keyframes, hover/active/disabled states

### Features — Implemented
- [terminal-core.md](features/implemented/terminal-core.md) — xterm.js, PTY, WebGL, resize, scrollback
- [workspaces-and-layout.md](features/implemented/workspaces-and-layout.md) — Workspaces, grid templates, splitting, tabs-per-pane
- [agents.md](features/implemented/agents.md) — Launcher catalog (claude, codex, claude-codex, grok, agy) and legacy agent definitions
- [theming.md](features/implemented/theming.md) — 30 bundled themes (9 light), 3 recommendations, runtime switching
- [persistence.md](features/implemented/persistence.md) — JSON storage, save/load flow, what persists
- [notifications.md](features/implemented/notifications.md) — Approval badges, notification panel, tab aggregation; historical flash notes
- [keyboard-shortcuts.md](features/implemented/keyboard-shortcuts.md) — Default shortcuts, platform mapping, and remapping
- [browser-pane.md](features/implemented/browser-pane.md) — Historical native browser backend (removed); links to current previews and Web panes
- [config-detection.md](features/implemented/config-detection.md) — ghostty/alacritty/kitty/Windows Terminal config detection
- [search-and-command-palette.md](features/implemented/search-and-command-palette.md) — Terminal find bar, Ctrl+P Resume palette; no general command palette
- [socket-api-and-automation.md](features/implemented/socket-api-and-automation.md) — Authenticated loopback TCP, newline-delimited JSON, Python CLI

### Research & Competitive Analysis
- [bridgespace-re/README.md](bridgespace-re/README.md) — BridgeSpace reverse engineering findings (stack, architecture, swarm protocol, auth, voice, network)
- [bridgespace-re/09-competitive/ptrcode-gaps.md](bridgespace-re/09-competitive/ptrcode-gaps.md) — Feature gap analysis and recommended build order for ptrcode

### Features — Pending / Partially Implemented (from cmux reference)
- [ssh-remote-sessions.md](features/pending/ssh-remote-sessions.md) — SSH daemon, reconnect, port forwarding
- [rich-browser.md](features/implemented/rich-browser.md) — General-browser proposal; current service Web panes are a separate feature
- [input-and-interaction.md](features/pending/input-and-interaction.md) — Copy mode, broadcast, file drop, clipboard images; shipped zoom, keybindings, URLs
- [accessibility-and-motion.md](features/pending/accessibility-and-motion.md) — Remaining ARIA, high contrast, i18n; reduced motion already shipped
- [ui-polish.md](features/pending/ui-polish.md) — Shipped glass, error states, notifications, light themes, restore; remaining polish
