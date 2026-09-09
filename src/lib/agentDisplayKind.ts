export type DisplayAgentKind = "claude" | "codex" | "claude-codex" | "grok" | "antigravity" | "hermes";

export const COMMAND_DISPLAY_KINDS: Record<string, DisplayAgentKind> = {
  agy: "antigravity",
  claude: "claude",
  codex: "codex",
  grok: "grok",
  // Hermes is launched by full path (hermes.exe), so the basename is what
  // identifies it here -- the launchers set no MYCMUX_AGENT_KIND for it.
  hermes: "hermes",
};

/**
 * Launch targets whose catalog row carries no `agentKind`, so a pane started
 * from the launcher menu has nothing else to identify it by: the PTY's own
 * command is the launcher shell, and Rust's process detection only knows the
 * four session kinds. `MYCMUX_LAUNCH_TARGET` is what the launcher dispatched
 * on, and the tab keeps it in `launchEnv`.
 */
export const LAUNCH_TARGET_DISPLAY_KINDS: Record<string, DisplayAgentKind> = {
  agy: "antigravity",
  hermes: "hermes",
};

export function resolveDisplayAgentKind(
  agentKind: string | null | undefined,
  commandArgv?: readonly string[] | null,
  launchTarget?: string | null,
): DisplayAgentKind | null {
  if (agentKind === "claude" || agentKind === "codex" || agentKind === "claude-codex" || agentKind === "grok") {
    return agentKind;
  }

  const command = commandArgv?.[0]
    ?.replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  const fromCommand = command ? COMMAND_DISPLAY_KINDS[command] ?? null : null;
  if (fromCommand) return fromCommand;
  return launchTarget ? LAUNCH_TARGET_DISPLAY_KINDS[launchTarget] ?? null : null;
}
