import type { ProjectRegistration } from "../../../src/lib/paneIdentity";
import type { PaneTab, Workspace } from "../../../src/types";
import { buildLocalGroupingScan } from "../../../src/components/layout/groupingLocalPlan";
import { createAutoNamePolicy, isAutomaticNameTarget, shortAutomaticName, type AutoNameMeaning } from "../../../src/lib/autoNamePolicy";
import { buildAutoNameEvidence, namingBinding, type AutoNameScan, type NamingMaterial } from "../../../src/lib/autoNameMaterial";
import { aggregateWorkspaceName, createAutoWorkspaceNamePolicy } from "../../../src/lib/autoWorkspaceNaming";
import { applyNamingPatches, beginNamingRecovery, undoNamingRecovery } from "../../../src/lib/autoNameRecovery";
import { fixtureMaterial } from "./autoNamingInvariants";

export interface QualityTab extends Omit<PaneTab, "sessionId" | "agentId"> {
  initialTitle: string;
  parentTabId?: string;
  events: Array<{ at: number; type: "userMessage" | "file"; kind?: "taskStart" | "taskChange" | "correction" | "ack" | "answer"; text?: string; path?: string; operation?: "read" | "write" }>;
}
export interface QualityExpectation { must?: string[]; forbidden?: string[]; protected?: boolean; restored?: boolean; unknown?: boolean; off?: boolean }
export interface QualityCase {
  id: string; category: "normal" | "failure" | "state"; reason: string; scenario?: string; failureType?: string;
  projects?: string[]; registrations?: ProjectRegistration[]; qualityEligible?: boolean; paneEnabled?: boolean; aiEnabled?: boolean; recovery?: boolean;
  workspaces: Array<{ id: string; name: string; nameSource?: "auto"; status: Workspace["status"]; tabs: QualityTab[] }>;
  frames: Array<{ at: number; stop?: boolean; replace?: boolean; undo?: boolean; manualRename?: string }>;
  expected: { tabs: Record<string, QualityExpectation>; distinctPrefixes?: boolean; duplicateException?: string; workspaceMust?: string[]; workspaceProtected?: boolean; jobs?: number };
}
export interface QualityResult {
  id: string; category: QualityCase["category"]; reason: string; qualityEligible: boolean;
  names: Array<{ id: string; full: string; short: string; before?: string; auto: boolean; expectation: QualityExpectation; evidenceRefs: string[] }>;
  workspace: { before: string; after: string; summary: ReturnType<typeof aggregateWorkspaceName> };
  commits: Array<{ at: number; id: string; full: string; instruction: string }>;
  before: Workspace[]; after: Workspace[];
}
export async function runQualityCase(fixture: QualityCase): Promise<QualityResult> {
  let now = 0; const policy = createAutoNamePolicy(() => now, () => fixture.registrations ?? fixture.projects ?? []);
  const workspacePolicy = createAutoWorkspaceNamePolicy(() => now);
  let workspaces: Workspace[] = fixture.workspaces.map(ws => ({ id: ws.id, name: ws.name, nameSource: ws.nameSource ?? undefined, status: ws.status,
    createdAt: 0, gridTemplateId: "1x1", splitColumns: [["pane-" + ws.id]], panes: [{ id: "pane-" + ws.id, activeTabId: ws.tabs[0]?.id ?? "",
      sessionId: "pty-" + ws.tabs[0]?.id, agentId: "shell-starter", tabs: ws.tabs.map(({ initialTitle: _title, events: _events, parentTabId, ...tab }) => ({
        // These fixtures score the rule-derived names and the unknown name. A launch label
        // replaces the unknown name since 2026-10-14 (autoNamePolicy's presented names), so they run unlabeled.
        ...tab, ...(tab.labelSource === "launch" ? { label: undefined } : {}),
        labelSource: tab.labelSource === "launch" ? undefined : tab.labelSource ?? undefined, displayName: tab.displayName ?? undefined, displayNameSource: tab.displayNameSource ?? undefined,
        sessionId: "pty-" + tab.id, agentId: "shell-starter", origin: parentTabId ? { kind: "agent", parentTabId } : { kind: "human" },
        launchEnv: { ORIGINAL: tab.id }, initialPrompt: "original-prompt", commandArgv: ["original-command", tab.id],
      })) }] }));
  const before = structuredClone(workspaces);
  const recovery = fixture.recovery ? beginNamingRecovery(workspaces) : null;
  if (recovery) workspaces = applyNamingPatches(workspaces, recovery.patches);
  if (fixture.paneEnabled === false) workspaces = workspaces.map(ws => ({ ...ws, panes: ws.panes.map(p => ({ ...p, tabs: p.tabs.map(t => isAutomaticNameTarget(t) ? { ...t, displayName: undefined, displayNameSource: undefined } : t) })) }));
  const commits: QualityResult["commits"] = []; let finalMeanings: ReadonlyMap<string, AutoNameMeaning> = new Map();
  const tabDefinitions = new Map(fixture.workspaces.flatMap(ws => ws.tabs.map(t => [t.id, t] as const)));
  for (const frame of fixture.frames) {
    now = frame.at;
    if (frame.stop) workspaces = workspaces.map(ws => ({ ...ws, status: "stopped" }));
    if (frame.replace) workspaces = workspaces.map(ws => ({ ...ws, panes: ws.panes.map(p => ({ ...p, tabs: p.tabs.map(t => ({ ...t, sessionId: "replacement-" + t.id, agentSessionId: "replacement-agent" })) })) }));
    if (frame.manualRename) workspaces = workspaces.map(ws => ({ ...ws, panes: ws.panes.map(p => ({ ...p, tabs: p.tabs.map(t => t.id === frame.manualRename ? { ...t, label: "後の手動名", labelSource: "user" } : t) })) }));
    if (frame.undo && recovery) { workspaces = applyNamingPatches(workspaces, undoNamingRecovery(workspaces, recovery.record)); break; }
    const base = await buildLocalGroupingScan({ workspaces, metadata: {}, attentionByTabId: {}, now });
    const scan: AutoNameScan = { ...base, tabs: base.tabs.filter(t => workspaces.find(w => w.id === t.workspaceId)?.status !== "stopped"), naming: new Map() };
    for (const tab of scan.tabs) {
      const definition = tabDefinitions.get(tab.id)!;
      const events = definition.events.filter(event => event.at <= now);
      const material: NamingMaterial = { tab_id: tab.id, pty_session_id: tab.sessionId, agent_kind: tab.agentKind,
        agent_session_id: tab.agentSessionId, cwd: tab.cwd, task_title: definition.initialTitle, events: events.map((event, i) => ({
          eventId: fixture.id + ":" + tab.id + ":" + i, occurredAt: event.at, sourceRevision: i + 1, sourceByteStart: i * 100, sourceByteEnd: (i + 1) * 100,
          kind: event.type === "file" ? { type: "toolStart", call_id: String(i), tool: event.operation === "write" ? "Write" : "Read", target: event.path ?? "" }
            : { type: "userMessage", kind: event.kind ?? "taskStart", text: event.text ?? "", digest: fixture.id + i },
        })) };
      if (tab.agentSessionId === "replacement-agent") material.events = [{ eventId: "replacement-u", occurredAt: now, sourceRevision: 1, sourceByteStart: 0, sourceByteEnd: 10,
        kind: { type: "userMessage", kind: "taskStart", text: "機材費の見積を作る", digest: "replacement" } }];
      scan.naming.set(tab.id, buildAutoNameEvidence(tab, fixtureMaterial(material)));
    }
    const identities = policy.identify(scan); finalMeanings = policy.meanings();
    const rows = new Map(scan.tabs.map(t => [t.id, t]));
    const tabPatches = fixture.paneEnabled === false ? [] : workspaces.flatMap(ws => ws.panes.flatMap(p => p.tabs.flatMap(tab => {
      const input = rows.get(tab.id); const name = identities.tabs.get(tab.id)?.displayName;
      if (!input || !name || !isAutomaticNameTarget(tab) || name === tab.displayName) return [];
      const evidence = scan.naming.get(tab.id)!;
      commits.push({ at: now, id: tab.id, full: name, instruction: evidence.instructions[0] ?? "" });
      return [{ id: tab.id, owner: namingBinding(tab), label: tab.label, expectedSource: tab.labelSource, labelSource: tab.labelSource, displayName: name, displayNameSource: "auto" as const }];
    })));
    const workspacePatches = workspaces.flatMap(ws => {
      const summary = aggregateWorkspaceName(ws, finalMeanings);
      const name = recovery && now === fixture.frames[0].at ? summary.name : workspacePolicy.candidate(ws, summary);
      if (!name || ws.nameSource !== "auto") return [];
      workspacePolicy.committed(ws.id, summary);
      return [{ id: ws.id, expectedName: ws.name, expectedSource: "auto" as const, name, nameSource: "auto" as const }];
    });
    workspaces = applyNamingPatches(workspaces, { tabs: tabPatches, workspaces: workspacePatches });
  }
  const names = workspaces.flatMap(w => w.panes.flatMap(p => p.tabs.map(t => ({ id: t.id,
    full: t.labelSource === "user" ? t.label ?? "" : t.displayName ?? t.label ?? "", short: t.labelSource === "user" ? t.label ?? "" : t.displayName ? shortAutomaticName(t.displayName) : t.label ?? "",
    before: before.flatMap(w => w.panes.flatMap(p => p.tabs)).find(tab => tab.id === t.id)?.displayName,
    auto: t.displayNameSource === "auto" && isAutomaticNameTarget(t), expectation: fixture.expected.tabs[t.id], evidenceRefs: finalMeanings.get(t.id)?.evidenceRefs ?? [],
  }))));
  return { id: fixture.id, category: fixture.category, reason: fixture.reason, qualityEligible: fixture.qualityEligible !== false,
    names, workspace: { before: before[0].name, after: workspaces[0].name, summary: aggregateWorkspaceName(workspaces[0], finalMeanings) }, commits, before, after: workspaces };
}
