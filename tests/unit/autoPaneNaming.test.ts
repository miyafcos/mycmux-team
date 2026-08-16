import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_PANE_NAMING_INTERVAL_MS,
  createAutoPaneNamingScheduler,
  type AutoPaneNamingDependencies,
} from "../../src/lib/autoPaneNaming";
import type { NamingPaneGroup, NamingTab } from "../../src/components/layout/tabSweep";
import type { PaneTab, Workspace } from "../../src/types";

const activeSchedulers = new Set<ReturnType<typeof createAutoPaneNamingScheduler>>();

function namingTab(
  id: string,
  overrides: Partial<NamingTab> = {},
): NamingTab {
  return {
    id,
    sessionId: `session-${id}`,
    label: "",
    cwd: "C:\\work",
    agentKind: "codex",
    isPaneHead: true,
    tail: ["prompt"],
    ...overrides,
  };
}

function workspaceTab(tab: NamingTab): PaneTab {
  return {
    id: tab.id,
    sessionId: tab.sessionId,
    agentId: "shell-starter",
    type: "terminal",
    label: tab.label || undefined,
    labelSource: tab.labelSource,
    cwd: tab.cwd,
    agentKind: tab.agentKind === "" ? undefined : tab.agentKind as PaneTab["agentKind"],
  };
}

function makeWorkspace(tabs: NamingTab[]): Workspace {
  const paneTabs = tabs.map(workspaceTab);
  return {
    id: "workspace",
    name: "Workspace",
    gridTemplateId: "1x1",
    panes: [{
      id: "pane",
      agentId: "shell-starter",
      sessionId: paneTabs[0]?.sessionId ?? "session-pane",
      tabs: paneTabs,
      activeTabId: paneTabs[0]?.id ?? "",
    }],
    status: "running",
    createdAt: 1,
  };
}

function group(...tabs: NamingTab[]): NamingPaneGroup[] {
  return [{ paneId: "pane", column: 1, tabs }];
}

function dependencies(
  groups: NamingPaneGroup[],
  overrides: Partial<AutoPaneNamingDependencies> = {},
): AutoPaneNamingDependencies {
  const workspaceState = {
    activeWorkspaceId: "workspace",
    workspaces: [makeWorkspace(groups.flatMap((entry) => entry.tabs))],
  };
  const workspaceListeners = new Set<() => void>();
  const autoListeners = new Set<(enabled: boolean, previous: boolean) => void>();
  const aiListeners = new Set<(enabled: boolean, previous: boolean) => void>();
  const settings = { aiEnabled: true, autoPaneNamingEnabled: true };
  return {
    settings: () => settings,
    scanNamingContext: vi.fn(async () => groups),
    invokeJudge: vi.fn(async () => JSON.stringify(
      groups.flatMap((entry) => entry.tabs).map((tab) => ({ id: tab.id, label: `名前 ${tab.id}` })),
    )),
    abortJudge: vi.fn(async () => true),
    getWorkspaceState: () => workspaceState,
    subscribeWorkspace: (listener) => {
      workspaceListeners.add(listener);
      return () => workspaceListeners.delete(listener);
    },
    subscribeAutoPaneNamingEnabled: (listener) => {
      autoListeners.add(listener);
      return () => autoListeners.delete(listener);
    },
    subscribeAiEnabled: (listener) => {
      aiListeners.add(listener);
      return () => aiListeners.delete(listener);
    },
    setTabLabel: vi.fn(),
    pushToast: vi.fn(),
    requestId: () => "request-1",
    getVisibility: () => "visible",
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...overrides,
  };
}

function schedulerFor(
  groups: NamingPaneGroup[],
  overrides: Partial<AutoPaneNamingDependencies> = {},
) {
  const scheduler = createAutoPaneNamingScheduler(dependencies(groups, overrides));
  activeSchedulers.add(scheduler);
  return scheduler;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const scheduler of activeSchedulers) scheduler.stop();
  activeSchedulers.clear();
  vi.useRealTimers();
});

describe("auto pane naming", () => {
  it("does not target a user-labelled tab", async () => {
    const tab = namingTab("user", { label: "手動名", labelSource: "user" });
    const deps = dependencies(group(tab));
    const scheduler = schedulerFor(group(tab), deps);

    await scheduler.runNow();

    expect(deps.invokeJudge).not.toHaveBeenCalled();
  });

  it("treats a labelled tab without labelSource as user-labelled", async () => {
    const tab = namingTab("legacy", { label: "旧データ" });
    const deps = dependencies(group(tab));
    const scheduler = schedulerFor(group(tab), deps);

    await scheduler.runNow();

    expect(deps.invokeJudge).not.toHaveBeenCalled();
  });

  it("targets an unnamed tab", async () => {
    const tab = namingTab("unnamed");
    const deps = dependencies(group(tab));
    const scheduler = schedulerFor(group(tab), deps);

    await scheduler.runNow();

    expect(deps.invokeJudge).toHaveBeenCalledTimes(1);
    expect(deps.setTabLabel).toHaveBeenCalledWith("workspace", "pane", "unnamed", "名前 unnamed", "ai");
  });

  it("retargets an AI-labelled tab only after its signature changes", async () => {
    const tab = namingTab("ai", { label: "AI名", labelSource: "ai", tail: ["one"] });
    const deps = dependencies(group(tab));
    const scheduler = schedulerFor(group(tab), deps);

    await scheduler.runNow();
    await scheduler.runNow();
    expect(deps.invokeJudge).toHaveBeenCalledTimes(1);

    tab.tail = ["two"];
    await scheduler.runNow();
    expect(deps.invokeJudge).toHaveBeenCalledTimes(2);
  });

  it("does not invoke when there are no targets", async () => {
    const deps = dependencies([]);
    const scheduler = schedulerFor([], deps);

    await scheduler.runNow();

    expect(deps.invokeJudge).not.toHaveBeenCalled();
  });

  it.each([
    ["AI is disabled", { aiEnabled: false, autoPaneNamingEnabled: true }],
    ["automatic naming is disabled", { aiEnabled: true, autoPaneNamingEnabled: false }],
  ])("does not run when %s", async (_name, settingValues) => {
    const tab = namingTab("off");
    const deps = dependencies(group(tab));
    Object.assign((deps.settings as () => { aiEnabled: boolean; autoPaneNamingEnabled: boolean })(), settingValues);
    const scheduler = schedulerFor(group(tab), deps);

    await scheduler.runNow();

    expect(deps.invokeJudge).not.toHaveBeenCalled();
  });

  it("skips a trigger while a naming request is running", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<string>((resolve) => { release = () => resolve('[{"id":"running","label":"実行中"}]'); });
    const deps = dependencies(group(namingTab("running")), {
      invokeJudge: vi.fn(async () => gate),
    });
    const scheduler = schedulerFor(group(namingTab("running")), deps);

    const first = scheduler.runNow();
    await Promise.resolve();
    await scheduler.runNow();
    expect(deps.invokeJudge).toHaveBeenCalledTimes(1);
    release?.();
    await first;
  });

  it("ignores proposals for tabs outside the target set", async () => {
    const tab = namingTab("target");
    const deps = dependencies(group(tab), {
      invokeJudge: vi.fn(async () => JSON.stringify([
        { id: "target", label: "対象" },
        { id: "outside", label: "対象外" },
      ])),
    });
    const scheduler = schedulerFor(group(tab), deps);

    await scheduler.runNow();

    expect(deps.setTabLabel).toHaveBeenCalledWith("workspace", "pane", "target", "対象", "ai");
    expect(deps.setTabLabel).not.toHaveBeenCalledWith("workspace", "pane", "outside", expect.anything(), "ai");
  });

  it("cancels pending work and stops the interval", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<string>((resolve) => { release = () => resolve('[{"id":"pending","label":"保留"}]'); });
    const deps = dependencies(group(namingTab("pending")), {
      invokeJudge: vi.fn(async () => gate),
    });
    const scheduler = schedulerFor(group(namingTab("pending")), deps);
    const run = scheduler.runNow();
    await Promise.resolve();

    scheduler.stop();
    vi.advanceTimersByTime(AUTO_PANE_NAMING_INTERVAL_MS + 90_000);
    expect(deps.abortJudge).toHaveBeenCalledWith("request-1");
    expect(deps.invokeJudge).toHaveBeenCalledTimes(1);
    release?.();
    await run;
  });
});

