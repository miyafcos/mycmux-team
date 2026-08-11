export type DisplayAgentKind = "claude" | "codex" | "claude-codex" | "antigravity";

export const COMMAND_DISPLAY_KINDS: Record<string, DisplayAgentKind> = {
  agy: "antigravity",
  claude: "claude",
  codex: "codex",
};

export function resolveDisplayAgentKind(
  agentKind: string | null | undefined,
  commandArgv?: readonly string[] | null,
): DisplayAgentKind | null {
  if (agentKind === "claude" || agentKind === "codex" || agentKind === "claude-codex") {
    return agentKind;
  }

  const command = commandArgv?.[0]
    ?.replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  return command ? COMMAND_DISPLAY_KINDS[command] ?? null : null;
}
