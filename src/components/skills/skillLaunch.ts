import { agentIdForSessionKind } from "../../lib/agentSessionConfig";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useUiStore } from "../../stores/uiStore";
import { skillsStrings as s } from "./skillsStrings";
import type { SkillRow } from "../../lib/skillsApi";

export function startSkill(row: SkillRow, kind: "claude" | "codex", repair = false): void {
  const workspace = useWorkspaceListStore.getState().getActiveWorkspace();
  const session = useUiStore.getState().activePaneId;
  const pane = workspace?.panes.find(p => p.tabs.some(t => t.sessionId === session)) ?? workspace?.panes[0];
  if (!workspace || !pane) throw new Error(s.noWorkspace);
  if (repair && !row.docPath) throw new Error(s.noDocument);
  const initialPrompt = repair ? s.repairPrompt(row.docPath!) : row.calls[kind];
  if (!initialPrompt) throw new Error(s.agentUnavailable);
  useWorkspaceLayoutStore.getState().addTabToPaneWithOptions(workspace.id, pane.id, {
    agentId: agentIdForSessionKind(kind) ?? undefined, agentKind: kind, label: row.label,
    cwd: pane.tabs.find(t => t.sessionId === session)?.cwd ?? pane.cwd,
    initialPrompt, activate: true,
  });
}
