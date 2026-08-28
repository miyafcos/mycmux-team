import { describe, expect, it } from "vitest";

import {
  persistentLayoutEquals,
  persistentLayoutProjection,
  persistentLayoutSignature,
} from "../../src/lib/persistentLayoutProjection";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const NOW = 1_800_000_000_000;

function fullTab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    label: `label-${id}`,
    labelSource: "user",
    type: "terminal",
    cwd: `C:/work/${id}`,
    lastProcess: "pwsh",
    claudeSessionId: `claude-${id}`,
    agentKind: "codex",
    agentSessionId: `agent-${id}`,
    suppressedAgentSessions: [{
      agentKind: "claude",
      agentSessionId: `sup-${id}`,
      claudeSessionId: `csup-${id}`,
    }],
    launchEnv: { TAB: id, ORDER: "first" },
    initialPrompt: "hello",
    commandArgv: ["cmd", id],
    ephemeral: false,
    terminalSnapshot: [`snap-${id}-0`, `snap-${id}-1`],
    turnMarks: [{ label: "turn", at: 1, lines_from_bottom: 2 }],
    htmlPath: `html/${id}`,
    sourcePath: `src/${id}`,
    sourceKind: "html",
    previewPath: `preview/${id}`,
    isDirty: false,
    reloadCounter: 1,
    lifecycle: "declared",
    origin: { kind: "agent", parentTabId: "parent" },
    declaredPrompt: "do",
    declaredTarget: "codex",
  };
}

function fullPane(id: string, tabs: PaneTab[]): Pane {
  const active = tabs[0];
  return {
    id,
    agentId: active.agentId,
    sessionId: active.sessionId,
    activeTabId: active.id,
    tabs,
    label: `pane-${id}`,
    cwd: active.cwd,
    gitBranch: "main",
    lastProcess: active.lastProcess,
    claudeSessionId: active.claudeSessionId,
    agentKind: active.agentKind,
    agentSessionId: active.agentSessionId,
    suppressedAgentSessions: structuredClone(active.suppressedAgentSessions),
    launchEnv: { PANE: id },
    pinnedTabId: active.id,
  };
}

function fullWorkspaces(): Workspace[] {
  const tabs = [fullTab("t1"), fullTab("t2")];
  return [{
    id: "ws-a",
    name: "母艦",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    color: "#4C8DF6",
    pet: "clawd",
    panes: [fullPane("pane-a", tabs)],
    splitColumns: [["pane-a"]],
    columnWidths: [1],
    rowHeightsPerCol: [[1]],
  }];
}

function agree(left: readonly Workspace[], right: readonly Workspace[]): void {
  const equal = persistentLayoutEquals(left, right);
  const signaturesMatch = persistentLayoutSignature(left) === persistentLayoutSignature(right);
  expect(equal).toBe(signaturesMatch);
}

type Mutation = { name: string; mutate: (workspaces: Workspace[]) => void };

const workspaceMutations: Mutation[] = [
  { name: "workspace.id", mutate: (ws) => { ws[0].id = "ws-other"; } },
  { name: "workspace.name", mutate: (ws) => { ws[0].name = "改名"; } },
  { name: "workspace.gridTemplateId", mutate: (ws) => { ws[0].gridTemplateId = "2x1"; } },
  { name: "workspace.status", mutate: (ws) => { ws[0].status = "stopped"; } },
  { name: "workspace.createdAt", mutate: (ws) => { ws[0].createdAt = NOW + 1; } },
  { name: "workspace.color", mutate: (ws) => { ws[0].color = "#1FA2B8"; } },
  { name: "workspace.pet", mutate: (ws) => { ws[0].pet = "other"; } },
  { name: "workspace.splitColumns", mutate: (ws) => { ws[0].splitColumns = [["pane-b"]]; } },
  { name: "workspace.columnWidths", mutate: (ws) => { ws[0].columnWidths = [9]; } },
  { name: "workspace.rowHeightsPerCol", mutate: (ws) => { ws[0].rowHeightsPerCol = [[9]]; } },
  { name: "workspace.panes", mutate: (ws) => { ws[0].panes = [...ws[0].panes, fullPane("pane-b", [fullTab("t9")])]; } },
];

const paneMutations: Mutation[] = [
  { name: "pane.id", mutate: (ws) => { ws[0].panes[0].id = "pane-other"; } },
  { name: "pane.agentId", mutate: (ws) => { ws[0].panes[0].agentId = "other-agent"; } },
  { name: "pane.sessionId", mutate: (ws) => { ws[0].panes[0].sessionId = "session-other"; } },
  { name: "pane.activeTabId", mutate: (ws) => { ws[0].panes[0].activeTabId = "t2"; } },
  { name: "pane.label", mutate: (ws) => { ws[0].panes[0].label = "other-pane"; } },
  { name: "pane.cwd", mutate: (ws) => { ws[0].panes[0].cwd = "C:/other"; } },
  { name: "pane.gitBranch", mutate: (ws) => { ws[0].panes[0].gitBranch = "dev"; } },
  { name: "pane.lastProcess", mutate: (ws) => { ws[0].panes[0].lastProcess = "bash"; } },
  { name: "pane.claudeSessionId", mutate: (ws) => { ws[0].panes[0].claudeSessionId = "claude-other"; } },
  { name: "pane.agentKind", mutate: (ws) => { ws[0].panes[0].agentKind = "claude"; } },
  { name: "pane.agentSessionId", mutate: (ws) => { ws[0].panes[0].agentSessionId = "agent-other"; } },
  {
    name: "pane.suppressedAgentSessions",
    mutate: (ws) => {
      ws[0].panes[0].suppressedAgentSessions = [{
        agentKind: "grok",
        agentSessionId: "sup-other",
        claudeSessionId: "csup-other",
      }];
    },
  },
  { name: "pane.launchEnv", mutate: (ws) => { ws[0].panes[0].launchEnv = { PANE: "changed" }; } },
  { name: "pane.pinnedTabId", mutate: (ws) => { ws[0].panes[0].pinnedTabId = "t2"; } },
  { name: "pane.tabs", mutate: (ws) => { ws[0].panes[0].tabs = [...ws[0].panes[0].tabs, fullTab("t9")]; } },
];

const tabMutations: Mutation[] = [
  { name: "tab.id", mutate: (ws) => { ws[0].panes[0].tabs[0].id = "t-other"; } },
  { name: "tab.sessionId", mutate: (ws) => { ws[0].panes[0].tabs[0].sessionId = "session-other"; } },
  { name: "tab.agentId", mutate: (ws) => { ws[0].panes[0].tabs[0].agentId = "other-agent"; } },
  { name: "tab.label", mutate: (ws) => { ws[0].panes[0].tabs[0].label = "other-label"; } },
  { name: "tab.labelSource", mutate: (ws) => { ws[0].panes[0].tabs[0].labelSource = "ai"; } },
  { name: "tab.type", mutate: (ws) => { ws[0].panes[0].tabs[0].type = "browser"; } },
  { name: "tab.cwd", mutate: (ws) => { ws[0].panes[0].tabs[0].cwd = "C:/other"; } },
  { name: "tab.lastProcess", mutate: (ws) => { ws[0].panes[0].tabs[0].lastProcess = "bash"; } },
  { name: "tab.claudeSessionId", mutate: (ws) => { ws[0].panes[0].tabs[0].claudeSessionId = "claude-other"; } },
  { name: "tab.agentKind", mutate: (ws) => { ws[0].panes[0].tabs[0].agentKind = "grok"; } },
  { name: "tab.agentSessionId", mutate: (ws) => { ws[0].panes[0].tabs[0].agentSessionId = "agent-other"; } },
  {
    name: "tab.suppressedAgentSessions",
    mutate: (ws) => {
      ws[0].panes[0].tabs[0].suppressedAgentSessions = [{
        agentKind: "grok",
        agentSessionId: "sup-other",
      }];
    },
  },
  { name: "tab.launchEnv", mutate: (ws) => { ws[0].panes[0].tabs[0].launchEnv = { TAB: "changed" }; } },
  { name: "tab.initialPrompt", mutate: (ws) => { ws[0].panes[0].tabs[0].initialPrompt = "other"; } },
  { name: "tab.commandArgv", mutate: (ws) => { ws[0].panes[0].tabs[0].commandArgv = ["other"]; } },
  { name: "tab.ephemeral", mutate: (ws) => { ws[0].panes[0].tabs[0].ephemeral = true; } },
  { name: "tab.terminalSnapshot", mutate: (ws) => { ws[0].panes[0].tabs[0].terminalSnapshot = ["changed"]; } },
  {
    name: "tab.turnMarks",
    mutate: (ws) => {
      ws[0].panes[0].tabs[0].turnMarks = [{ label: "other", at: 9, lines_from_bottom: 8 }];
    },
  },
  { name: "tab.htmlPath", mutate: (ws) => { ws[0].panes[0].tabs[0].htmlPath = "html/other"; } },
  { name: "tab.sourcePath", mutate: (ws) => { ws[0].panes[0].tabs[0].sourcePath = "src/other"; } },
  { name: "tab.sourceKind", mutate: (ws) => { ws[0].panes[0].tabs[0].sourceKind = "markdown"; } },
  { name: "tab.previewPath", mutate: (ws) => { ws[0].panes[0].tabs[0].previewPath = "preview/other"; } },
  { name: "tab.isDirty", mutate: (ws) => { ws[0].panes[0].tabs[0].isDirty = true; } },
  { name: "tab.reloadCounter", mutate: (ws) => { ws[0].panes[0].tabs[0].reloadCounter = 9; } },
  { name: "tab.lifecycle", mutate: (ws) => { delete ws[0].panes[0].tabs[0].lifecycle; } },
  { name: "tab.origin", mutate: (ws) => { ws[0].panes[0].tabs[0].origin = { kind: "human" }; } },
  { name: "tab.declaredPrompt", mutate: (ws) => { ws[0].panes[0].tabs[0].declaredPrompt = "other"; } },
  { name: "tab.declaredTarget", mutate: (ws) => { ws[0].panes[0].tabs[0].declaredTarget = "claude"; } },
];

const nestedMutations: Mutation[] = [
  { name: "tab.origin.kind", mutate: (ws) => { ws[0].panes[0].tabs[0].origin = { kind: "human", parentTabId: "parent" }; } },
  { name: "tab.origin.parentTabId", mutate: (ws) => { ws[0].panes[0].tabs[0].origin = { kind: "agent", parentTabId: "other" }; } },
  { name: "tab.launchEnv.key", mutate: (ws) => { ws[0].panes[0].tabs[0].launchEnv = { TAB: "t1", ORDER: "second" }; } },
  { name: "tab.turnMarks.label", mutate: (ws) => { ws[0].panes[0].tabs[0].turnMarks = [{ label: "changed", at: 1, lines_from_bottom: 2 }]; } },
  { name: "tab.terminalSnapshot[0]", mutate: (ws) => { ws[0].panes[0].tabs[0].terminalSnapshot = ["changed", "snap-t1-1"]; } },
  { name: "tab.commandArgv[0]", mutate: (ws) => { ws[0].panes[0].tabs[0].commandArgv = ["other", "t1"]; } },
  {
    name: "tab.suppressedAgentSessions.agentKind",
    mutate: (ws) => {
      ws[0].panes[0].tabs[0].suppressedAgentSessions = [{
        agentKind: "grok",
        agentSessionId: "sup-t1",
        claudeSessionId: "csup-t1",
      }];
    },
  },
  { name: "workspace.splitColumns[0][0]", mutate: (ws) => { ws[0].splitColumns = [["pane-other"]]; } },
  { name: "workspace.columnWidths[0]", mutate: (ws) => { ws[0].columnWidths = [3]; } },
  { name: "workspace.rowHeightsPerCol[0][0]", mutate: (ws) => { ws[0].rowHeightsPerCol = [[3]]; } },
];

describe("persistentLayoutEquals agrees with signature", () => {
  it("keeps initialPrompt, commandArgv, and ephemeral in the persistent projection", () => {
    const projected = persistentLayoutProjection(fullWorkspaces());
    expect(projected.workspaces[0].panes[0].tabs[0]).toMatchObject({
      initialPrompt: "hello",
      commandArgv: ["cmd", "t1"],
      ephemeral: false,
    });
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite persistent numbers at projection entry: %s", (value) => {
    const layout = fullWorkspaces();
    layout[0].createdAt = value;
    expect(() => persistentLayoutProjection(layout)).toThrow(/non-finite persistent number/i);
  });

  it("distinguishes negative zero from zero", () => {
    const left = fullWorkspaces();
    const right = structuredClone(left);
    left[0].createdAt = -0;
    right[0].createdAt = 0;
    expect(persistentLayoutEquals(left, right)).toBe(false);
    expect(persistentLayoutSignature(left)).not.toBe(persistentLayoutSignature(right));
  });

  it("preserves an own __proto__ launchEnv key without signature collision", () => {
    const left = fullWorkspaces();
    const right = structuredClone(left);
    const leftEnv = Object.create(null) as Record<string, string>;
    const rightEnv = Object.create(null) as Record<string, string>;
    Object.defineProperty(leftEnv, "__proto__", { enumerable: true, value: "left" });
    Object.defineProperty(rightEnv, "__proto__", { enumerable: true, value: "right" });
    left[0].panes[0].tabs[0].launchEnv = leftEnv;
    right[0].panes[0].tabs[0].launchEnv = rightEnv;
    expect(persistentLayoutEquals(left, right)).toBe(false);
    expect(persistentLayoutSignature(left)).not.toBe(persistentLayoutSignature(right));
  });

  it.each([
    ["origin", (layout: Workspace[]) => Object.assign(layout[0].panes[0].tabs[0].origin as object, { futureField: "future" })],
    ["turnMarks", (layout: Workspace[]) => Object.assign(layout[0].panes[0].tabs[0].turnMarks![0] as object, { futureField: "future" })],
    ["tab suppressed session", (layout: Workspace[]) => Object.assign(layout[0].panes[0].tabs[0].suppressedAgentSessions![0] as object, { futureField: "future" })],
    ["pane suppressed session", (layout: Workspace[]) => Object.assign(layout[0].panes[0].suppressedAgentSessions![0] as object, { futureField: "future" })],
  ] as const)("ignores unknown nested fields consistently for %s", (_name, addFutureField) => {
    const left = fullWorkspaces();
    const right = structuredClone(left);
    addFutureField(right);
    expect(persistentLayoutProjection(right)).toEqual(persistentLayoutProjection(left));
    expect(persistentLayoutEquals(left, right)).toBe(true);
    expect(persistentLayoutSignature(left)).toBe(persistentLayoutSignature(right));
  });

  it("matches signature for a structural clone", () => {
    const left = fullWorkspaces();
    const right = structuredClone(left);
    agree(left, right);
    expect(persistentLayoutEquals(left, right)).toBe(true);
  });

  it("treats undefined layout metrics as empty arrays", () => {
    const left = fullWorkspaces();
    const right = structuredClone(left);
    right[0].columnWidths = undefined;
    left[0].columnWidths = [];
    right[0].rowHeightsPerCol = undefined;
    left[0].rowHeightsPerCol = [];
    right[0].splitColumns = undefined;
    left[0].splitColumns = [];
    agree(left, right);
    expect(persistentLayoutEquals(left, right)).toBe(true);
  });

  it("treats launchEnv key order as equal and empty env as distinct from missing", () => {
    const left = fullWorkspaces();
    const right = structuredClone(left);
    right[0].panes[0].tabs[0].launchEnv = { ORDER: "first", TAB: "t1" };
    agree(left, right);
    expect(persistentLayoutEquals(left, right)).toBe(true);

    const missing = structuredClone(left);
    missing[0].panes[0].tabs[0].launchEnv = undefined;
    const empty = structuredClone(left);
    empty[0].panes[0].tabs[0].launchEnv = {};
    agree(missing, empty);
    expect(persistentLayoutEquals(missing, empty)).toBe(false);
  });

  it("keeps equals and signature aligned when a persistent value is undefined", () => {
    const left = fullWorkspaces();
    const right = structuredClone(left);
    right[0].pet = undefined;

    agree(left, right);
    expect(persistentLayoutEquals(left, right)).toBe(false);
    expect(persistentLayoutSignature(left)).not.toBe(persistentLayoutSignature(right));
  });

  it("keeps equals and signature aligned for sparse persistent arrays", () => {
    const empty = fullWorkspaces();
    const sparse = structuredClone(empty);
    empty[0].columnWidths = [];
    sparse[0].columnWidths = new Array(1);

    expect(persistentLayoutEquals(empty, sparse)).toBe(false);
    expect(persistentLayoutSignature(empty)).not.toBe(persistentLayoutSignature(sparse));
  });

  it.each([
    ...workspaceMutations,
    ...paneMutations,
    ...tabMutations,
    ...nestedMutations,
  ])("$name changes both equals and signature", ({ mutate }) => {
    const left = fullWorkspaces();
    const right = structuredClone(left);
    mutate(right);
    agree(left, right);
    expect(persistentLayoutEquals(left, right)).toBe(false);
  });
});

function heavyLayout(): Workspace[] {
  const snapshot = Array.from({ length: 500 }, (_, index) => `line-${index}`);
  const tabs = Array.from({ length: 100 }, (_, index) => ({
    ...fullTab(`t${index}`),
    terminalSnapshot: snapshot.slice(),
  }));
  return [{
    id: "ws-heavy",
    name: "heavy",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    color: "#4C8DF6",
    pet: "clawd",
    panes: [fullPane("pane-a", tabs)],
    splitColumns: [["pane-a"]],
    columnWidths: [1],
    rowHeightsPerCol: [[1]],
  }];
}

function medianMs(run: () => void, samples = 21): number {
  run();
  run();
  const measured: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    run();
    measured.push(performance.now() - started);
  }
  measured.sort((left, right) => left - right);
  return measured[Math.floor(measured.length / 2)];
}

function legacyEquals(a: readonly Workspace[], b: readonly Workspace[]): boolean {
  if (a === b) return true;
  return JSON.stringify(persistentLayoutProjection(a)) === JSON.stringify(persistentLayoutProjection(b));
}

describe("persistentLayoutEquals hot path", () => {
  it("compares 100 tabs × 500 snapshot lines in under 3ms", () => {
    const left = heavyLayout();
    const right = structuredClone(left);
    expect(persistentLayoutEquals(left, right)).toBe(true);

    const after = medianMs(() => {
      if (!persistentLayoutEquals(left, right)) throw new Error("expected equal layouts");
    });
    const before = medianMs(() => {
      if (!legacyEquals(left, right)) throw new Error("expected equal layouts");
    });
    console.log(`persistentLayoutEquals median: after=${after.toFixed(3)}ms before=${before.toFixed(3)}ms`);
    expect(after).toBeLessThan(3);
  });
});
