import { namingBinding } from "./autoNameMaterial";
import type { Pane, PaneTab, Workspace } from "../types";
import { fitPresentedName, isPresentedMeaning, nameGraphemes, shortAutomaticName, UNKNOWN_AUTO_NAME, type AutoNameMeaning } from "./autoNamePolicy";

import { autoNameDescription } from "./autoNameStatus";

export interface WorkspaceNameSummary {
  name: string | null;
  key: string;
  description: string;
  jobs: number;
  unknown: number;
  /** Weight-independent semantic composition of eligible known and unknown owners. */
  support: ReadonlyArray<readonly [string, string]>;
  onlyHeld: boolean;
}
function matchesOwner(tab: PaneTab, meaning?: AutoNameMeaning, includeUnknown = false): meaning is AutoNameMeaning {
  if (!meaning || (!includeUnknown && meaning.strength === "unknown")) return false;
  try {
    const binding = JSON.parse(meaning.binding) as unknown[];
    return binding[0] === tab.id && binding[1] === tab.sessionId
      && (!tab.agentKind || binding[2] === tab.agentKind)
      && (!tab.agentSessionId || binding[3] === tab.agentSessionId);
  } catch { return false; }
}
/** Every tab votes; a related worker shares a vote only for the same concrete job. */
export function aggregateWorkspaceName(workspace: Workspace, meanings: ReadonlyMap<string, AutoNameMeaning>,
  bindingFor: (tab: PaneTab, pane: Pane) => string = namingBinding): WorkspaceNameSummary {
  const members = workspace.panes.flatMap(pane => pane.tabs.filter(tab => tab.type !== "launcher" && tab.lifecycle !== "declared" && !tab.ephemeral)
    .map(tab => ({ tab, pane })));
  const byId = new Map(members.map(({ tab }) => [tab.id, tab]));
  const jobs = new Map<string, { topic: string; weight: number; names: Set<string>; presented: boolean }>();
  let unknown = 0, labelled = 0;
  const reasons = new Map<string, number>();
  const composition: string[] = [];
  const support: Array<readonly [string, string]> = [];
  for (const { tab, pane } of members) {
    const meaning = meanings.get(tab.id);
    const reason = autoNameDescription(meaning);
    if (reason && (meaning?.strength === "unknown" || meaning?.staleSince !== undefined)) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    // A launch label stands in for a tab's name only; letting it vote would swap the
    // workspace name whenever the tab moves between its label and a rule name.
    if (!matchesOwner(tab, meaning) || meaning.source === "label") {
      // Unknown owners need a current binding even without accepted task evidence.
      const key = JSON.stringify([bindingFor(tab, pane), "unknown"]);
      if (meaning?.source === "label") labelled++;
      unknown++; support.push([tab.id, key]); composition.push(key); continue;
    }
    let root = tab.id;
    let parent = tab.origin?.parentTabId;
    const visited = new Set([root]);
    let cycle = false;
    while (parent) {
      if (visited.has(parent)) { cycle = true; break; }
      visited.add(parent);
      const ancestor = byId.get(parent); const ancestorMeaning = meanings.get(parent);
      if (!ancestor || !matchesOwner(ancestor, ancestorMeaning) || ancestorMeaning.meaningKey !== meaning.meaningKey) break;
      root = ancestor.id; parent = ancestor.origin?.parentTabId;
    }
    // A malformed lineage cycle never merges two otherwise independent owners.
    if (cycle) root = tab.id;
    const key = root + "|" + meaning.meaningKey;
    const weight = meaning.fresh && workspace.status === "running" ? 1 : 0.5;
    const job = jobs.get(key) ?? { topic: meaning.topic, weight: 0, names: new Set<string>(), presented: isPresentedMeaning(meaning) };
    job.weight = Math.max(job.weight, weight); job.names.add(meaning.fullName); jobs.set(key, job);
    support.push([tab.id, JSON.stringify([meaning.binding, meaning.meaningKey, root])]);
    composition.push(JSON.stringify([tab.id, key, meaning.binding, weight]));
  }
  const topics = new Map<string, { weight: number; count: number; names: Set<string>; presented: boolean }>();
  for (const job of jobs.values()) {
    const topic = topics.get(job.topic) ?? { weight: 0, count: 0, names: new Set<string>(), presented: job.presented };
    topic.weight += job.weight; topic.count++; for (const name of job.names) topic.names.add(name); topics.set(job.topic, topic);
  }
  const previousOrder = workspace.name.split("・");
  const order = (topic: string) => { const index = previousOrder.indexOf(topic); return index < 0 ? Infinity : index; };
  const ranked = [...topics].sort((a, b) => b[1].weight - a[1].weight || order(a[0]) - order(b[0]) || a[0].localeCompare(b[0], "ja"));
  const count = jobs.size + unknown;
  const totalWeight = ranked.reduce((sum, [, topic]) => sum + topic.weight, 0);
  const covered = count ? totalWeight / count : 0;
  const dominant = ranked[0] && covered >= 0.8 && ranked[0][1].weight / totalWeight >= 0.7;
  // Unknown and held jobs are recomposed; policy decides whether prior support
  // is unchanged. No visible saved name is decoded into evidence here.
  let name: string | null = UNKNOWN_AUTO_NAME;
  const onlyHeld = jobs.size > 0 && [...jobs.values()].every(job => job.weight < 1);
  if (ranked.length) {
    const selected = dominant ? ranked.slice(0, 1) : ranked.slice(0, 2);
    const remainder = ranked.length - selected.length + unknown;
    // Session titles have no task suffix for shortAutomaticName to keep; shorten them at a boundary.
    const fit = (text: string, presented: boolean, cap = 20) => presented ? fitPresentedName(text, cap) : shortAutomaticName(text, cap);
    const only = jobs.size === 1 && unknown === 0 ? [...jobs.values()][0] : undefined;
    name = only
      ? fit(only.names.values().next().value ?? selected[0][0], only.presented)
      : selected.map(([topic]) => topic).join("・") + (remainder ? `・ほか${remainder}` : "");
    // Workspace names use complete topic phrases, bounded separately from pane full names.
    if (nameGraphemes(name).length > 20) {
      const suffix = `・ほか${ranked.length - 1 + unknown}`;
      name = fit(selected[0][0], selected[0][1].presented, 20 - nameGraphemes(suffix).length) + suffix;
    }
  }
  const description = ranked.map(([topic, info]) => `${topic} ${info.count}件: ${[...info.names].sort().join("、")}`)
    .concat(labelled ? [`起動時の名前 ${labelled}件`] : [])
    .concat(unknown - labelled ? [`作業内容未取得 ${unknown - labelled}件`] : [])
    .concat([...reasons].map(([reason, count]) => `${reason} ${count}件`))
    .concat(onlyHeld ? ["最新の作業内容は未取得 (前回の材料)"] : []).join("\n");
  return { name: workspace.status === "stopped" ? null : name, key: JSON.stringify(composition.sort()), description, jobs: count, unknown,
    support: support.sort(([a], [b]) => a.localeCompare(b)), onlyHeld };
}
export function createAutoWorkspaceNamePolicy(now: () => number = Date.now) {
  const pending = new Map<string, { key: string; supportKey: string; since: number; observed: number; count: number }>();
  const lastCommit = new Map<string, number>();
  const committedSupport = new Map<string, ReadonlyMap<string, string>>();
  return {
    candidate(workspace: Workspace, summary: WorkspaceNameSummary): string | null {
      const prior = committedSupport.get(workspace.id);
      const unchangedSupport = prior && prior.size === summary.support.length && summary.support.every(([id, key]) => prior.get(id) === key);
      if (workspace.nameSource !== "auto" || workspace.status === "stopped" || !summary.name || workspace.name === summary.name
        || (summary.onlyHeld && unchangedSupport)) { pending.delete(workspace.id); return null; }
      const stamp = now(); const key = JSON.stringify([summary.name, summary.key]);
      const supportKey = JSON.stringify([summary.name, summary.support]);
      let proposal = pending.get(workspace.id);
      if (!proposal || (proposal.key !== key && proposal.supportKey !== supportKey)) { proposal = { key, supportKey, since: stamp, observed: stamp, count: 1 }; pending.set(workspace.id, proposal); }
      proposal.key = key;
      if (stamp - proposal.observed >= 30_000) { proposal.count++; proposal.observed = stamp; }
      const wait = stamp - workspace.createdAt < 120_000 ? 30_000 : 120_000;
      if (proposal.count < 2 || stamp - proposal.since < wait || stamp - (lastCommit.get(workspace.id) ?? -Infinity) < 300_000) return null;
      return summary.name;
    },
    committed(id: string, summary: WorkspaceNameSummary) {
      committedSupport.set(id, new Map(summary.support)); lastCommit.set(id, now()); pending.delete(id);
    },
    reset(ids: readonly string[]) { for (const id of ids) { pending.delete(id); lastCommit.delete(id); committedSupport.delete(id); } },
    prune(ids: ReadonlySet<string>) {
      for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
      for (const id of lastCommit.keys()) if (!ids.has(id)) lastCommit.delete(id);
      for (const id of committedSupport.keys()) if (!ids.has(id)) committedSupport.delete(id);
    },
  };
}
