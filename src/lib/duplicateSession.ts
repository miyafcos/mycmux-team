import type { AgentSessionKind } from "../types";
import type { PaneMetadata } from "../stores/paneMetadataStore";
import type { DuplicateAgentSessionResult } from "./ipc";
import { agentIdForSessionKind } from "./agentSessionConfig";

export interface DuplicateSessionSource {
  agentKind: AgentSessionKind;
  agentSessionId: string;
  cwd?: string;
  label: string;
}

interface DuplicateSessionSourceInput {
  metadata: Pick<PaneMetadata, "agentKind" | "agentSessionId"> | undefined;
  metadataCwd?: string;
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

export interface ClonedDuplicateSessionPaneOptions {
  agentId: "claude-code" | "codex" | "grok" | "shell-starter";
  label: string;
  cwd: string;
  agentKind: AgentSessionKind;
  agentSessionId: string;
}

export function buildClonedDuplicateSessionPaneOptions(
  source: DuplicateSessionSource,
  clone: DuplicateAgentSessionResult,
): ClonedDuplicateSessionPaneOptions {
  return {
    agentId: agentIdForSessionKind(clone.agent_kind)!,
    label: source.label,
    cwd: clone.resolved_cwd,
    agentKind: clone.agent_kind,
    agentSessionId: clone.new_session_id,
  };
}

export function resolveDuplicateSessionSource({
  metadata,
  metadataCwd,
  tabCwd,
  paneCwd,
  label,
}: DuplicateSessionSourceInput): DuplicateSessionSource | null {
  if (!metadata?.agentKind || !metadata.agentSessionId) return null;

  return {
    agentKind: metadata.agentKind,
    agentSessionId: metadata.agentSessionId,
    cwd: metadataCwd ?? tabCwd ?? paneCwd,
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
