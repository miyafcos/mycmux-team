import type { AgentSessionKind } from "../types";
import type { PaneMetadata } from "../stores/paneMetadataStore";

export interface DuplicateSessionSource {
  agentKind: AgentSessionKind;
  agentSessionId: string;
  cwd?: string;
  label: string;
}

interface DuplicateSessionSourceInput {
  metadata: Pick<PaneMetadata, "agentKind" | "agentSessionId"> | undefined;
  tabCwd?: string;
  paneCwd?: string;
  label: string;
}

export interface DuplicateSessionPaneOptions {
  agentId: "shell-starter";
  label: string;
  cwd?: string;
  agentKind: AgentSessionKind;
  launchEnv: Record<string, string>;
}

export function buildForkDuplicateSessionPaneOptions(
  source: DuplicateSessionSource,
): DuplicateSessionPaneOptions {
  return {
    agentId: "shell-starter",
    label: source.label,
    cwd: source.cwd,
    agentKind: source.agentKind,
    launchEnv: {
      MYCMUX_AGENT_KIND: source.agentKind,
      MYCMUX_RESUME: source.agentKind,
      MYCMUX_SESSION_ID: source.agentSessionId,
      MYCMUX_RESUME_FORK: "1",
    },
  };
}

export function resolveDuplicateSessionSource({
  metadata,
  tabCwd,
  paneCwd,
  label,
}: DuplicateSessionSourceInput): DuplicateSessionSource | null {
  if (!metadata?.agentKind || !metadata.agentSessionId) return null;

  return {
    agentKind: metadata.agentKind,
    agentSessionId: metadata.agentSessionId,
    cwd: tabCwd ?? paneCwd,
    label,
  };
}

export function buildDuplicateSessionPaneOptions(
  source: DuplicateSessionSource,
  handoffPromptFile: string,
): DuplicateSessionPaneOptions {
  const launchEnv: Record<string, string> = {
    MYCMUX_AGENT_KIND: source.agentKind,
    MYCMUX_HANDOFF: source.agentKind,
    MYCMUX_HANDOFF_FROM: source.agentKind,
    MYCMUX_HANDOFF_PROMPT_FILE: handoffPromptFile,
    MYCMUX_HANDOFF_FROM_SESSION: source.agentSessionId,
  };

  return {
    agentId: "shell-starter",
    label: source.label,
    cwd: source.cwd,
    agentKind: source.agentKind,
    launchEnv,
  };
}
