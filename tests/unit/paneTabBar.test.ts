import { describe, expect, it } from "vitest";
import type { PaneTab } from "../../src/types";
import {
  isTabActivationKey,
  formatHiddenTabCount,
  resolveHiddenTabStatus,
  PANE_TABBAR_COMPACT_ENTER,
  PANE_TABBAR_COMPACT_EXIT,
  PANE_TABBAR_COMPACT1_ENTER,
  PANE_TABBAR_COMPACT1_EXIT,
  PANE_TABBAR_COMPACT2_ENTER,
  PANE_TABBAR_COMPACT2_EXIT,
  PANE_TABBAR_COMPACT3_ENTER,
  PANE_TABBAR_COMPACT3_EXIT,
  PANE_TABBAR_MICRO_ENTER,
  PANE_TABBAR_MICRO_EXIT,
  PANE_TABBAR_SLIM_ENTER,
  PANE_TABBAR_SLIM_EXIT,
  resolveActiveAgentLabel,
  resolvePaneTabBarActions,
  resolveTabStatusIndicator,
  resolvePaneTabMenuLeft,
  resolvePaneTabMenuRows,
  resolvePaneTabBarMode,
  shouldCloseTabOnAuxClick,
  shouldMarkAttentionSeen,
  shouldShowDeferredRestoreBadge,
  shouldShowPublishButton,
} from "../../src/components/workspace/PaneTabBar";
import type { SessionAttention } from "../../src/stores/sessionAttentionStore";
import type {
  PaneTabBarActionId,
  PaneTabBarMode,
} from "../../src/components/workspace/PaneTabBar";

function tab(overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id: "tab",
    sessionId: "terminal-session",
    agentId: "shell-starter",
    type: "terminal",
    ...overrides,
  };
}

describe("shouldShowPublishButton", () => {
  it("shows for launcher tabs when live metadata identifies Claude", () => {
    expect(shouldShowPublishButton(tab(), { agentKind: "claude" })).toBe(true);
  });

  it("shows when a Claude session id is known without relying on agentId", () => {
    expect(shouldShowPublishButton(tab({ claudeSessionId: "session-id" }), undefined)).toBe(true);
    expect(shouldShowPublishButton(tab(), { claudeSessionId: "session-id" })).toBe(true);
  });

  it("shows for Codex metadata and persisted Codex session markers", () => {
    expect(shouldShowPublishButton(tab(), {
      agentKind: "codex",
      agentSessionId: "codex-session",
    })).toBe(true);
    expect(shouldShowPublishButton(tab({
      agentKind: "codex",
      agentSessionId: "codex-session",
    }), undefined)).toBe(true);
  });

  it("does not show for a bare shell or unsupported tab types", () => {
    expect(shouldShowPublishButton(tab(), {})).toBe(false);
    expect(shouldShowPublishButton(tab(), undefined)).toBe(false);
    expect(shouldShowPublishButton(tab({ type: "browser", agentKind: "claude" }), undefined)).toBe(false);
    expect(shouldShowPublishButton(tab({ type: "online", claudeSessionId: "session-id" }), undefined)).toBe(false);
  });

  it("does not show for unsupported claude-codex sessions", () => {
    expect(shouldShowPublishButton(tab({
      agentKind: "claude-codex",
      agentSessionId: "claude-codex-session",
    }), undefined)).toBe(false);
    expect(shouldShowPublishButton(tab(), {
      agentKind: "claude-codex",
      agentSessionId: "claude-codex-session",
    })).toBe(false);
  });

  it("stays visible while the agent runs a shell subprocess (transient shell foreground)", () => {
    // The deepest-child heuristic reports a shell while claude executes a
    // tool command; the button must not blink out during that window.
    expect(shouldShowPublishButton(tab(), { agentKind: "claude" })).toBe(true);
    expect(shouldShowPublishButton(tab({ claudeSessionId: "session-id" }), {})).toBe(true);
  });

  it("does not use the launch-time claude-code agentId as a gate", () => {
    expect(shouldShowPublishButton(tab({ agentId: "claude-code" }), undefined)).toBe(false);
  });
});

describe("shouldShowDeferredRestoreBadge", () => {
  it("shows for an inactive saved agent session that has not mounted a terminal", () => {
    expect(shouldShowDeferredRestoreBadge(tab({
      agentKind: "codex",
      agentSessionId: "session-id",
    }), false, false)).toBe(true);
    expect(shouldShowDeferredRestoreBadge(tab({
      claudeSessionId: "legacy-claude-session",
    }), false, false)).toBe(true);
  });

  it("hides after activation or once a terminal buffer exists", () => {
    const saved = tab({ agentKind: "claude", agentSessionId: "session-id" });
    expect(shouldShowDeferredRestoreBadge(saved, true, false)).toBe(false);
    expect(shouldShowDeferredRestoreBadge(saved, false, true)).toBe(false);
  });

  it("does not treat launch configuration or snapshots as a saved conversation", () => {
    expect(shouldShowDeferredRestoreBadge(tab({ agentId: "claude-code" }), false, false)).toBe(false);
    expect(shouldShowDeferredRestoreBadge(tab({ terminalSnapshot: ["old output"] }), false, false)).toBe(false);
  });

  it("does not show on browser or online tabs", () => {
    const saved = { agentKind: "claude" as const, agentSessionId: "session-id" };
    expect(shouldShowDeferredRestoreBadge(tab({ ...saved, type: "browser" }), false, false)).toBe(false);
    expect(shouldShowDeferredRestoreBadge(tab({ ...saved, type: "online" }), false, false)).toBe(false);
  });
});

describe("resolveTabStatusIndicator", () => {
  it("keeps error ahead of all other tab signals", () => {
    expect(resolveTabStatusIndicator({
      unreadAttentionCategory: "error",
      notificationCount: 1,
      displayStatus: "working",
    })).toBe("error");
  });

  it.each([
    { unreadAttentionCategory: null, notificationCount: 0, displayStatus: "waiting" as const },
    { unreadAttentionCategory: null, notificationCount: 1, displayStatus: "working" as const },
    { unreadAttentionCategory: "waiting" as const, notificationCount: 0, displayStatus: "working" as const },
  ])("keeps waiting ahead of working: %o", (input) => {
    expect(resolveTabStatusIndicator(input)).toBe("waiting");
  });

  it.each([
    { unreadAttentionCategory: null, notificationCount: 0, displayStatus: "working" as const },
    { unreadAttentionCategory: "done" as const, notificationCount: 0, displayStatus: "working" as const },
  ])("does not show done ahead of working: %o", (input) => {
    expect(resolveTabStatusIndicator(input)).toBe("working");
  });

  it("shows working only after higher-priority signals are absent", () => {
    expect(resolveTabStatusIndicator({
      unreadAttentionCategory: null,
      notificationCount: 0,
      displayStatus: "working",
    })).toBe("working");
  });

  it("returns no indicator for an idle tab without attention", () => {
    expect(resolveTabStatusIndicator({
      unreadAttentionCategory: null,
      notificationCount: 0,
      displayStatus: "idle",
    })).toBeNull();
  });
});

describe("isTabActivationKey", () => {
  it("accepts Enter and Space without treating navigation keys as activation", () => {
    expect(isTabActivationKey("Enter")).toBe(true);
    expect(isTabActivationKey(" ")).toBe(true);
    expect(isTabActivationKey("ArrowRight")).toBe(false);
  });
});

describe("resolvePaneTabBarMode", () => {
  const boundaries: Array<{
    name: string;
    wider: PaneTabBarMode;
    narrower: PaneTabBarMode;
    enter: number;
    exit: number;
  }> = [
    {
      name: "full/slim",
      wider: "full",
      narrower: "slim",
      enter: PANE_TABBAR_SLIM_ENTER,
      exit: PANE_TABBAR_SLIM_EXIT,
    },
    {
      name: "slim/compact",
      wider: "slim",
      narrower: "compact",
      enter: PANE_TABBAR_COMPACT_ENTER,
      exit: PANE_TABBAR_COMPACT_EXIT,
    },
    {
      name: "compact/compact3",
      wider: "compact",
      narrower: "compact3",
      enter: PANE_TABBAR_COMPACT3_ENTER,
      exit: PANE_TABBAR_COMPACT3_EXIT,
    },
    {
      name: "compact3/compact2",
      wider: "compact3",
      narrower: "compact2",
      enter: PANE_TABBAR_COMPACT2_ENTER,
      exit: PANE_TABBAR_COMPACT2_EXIT,
    },
    {
      name: "compact2/compact1",
      wider: "compact2",
      narrower: "compact1",
      enter: PANE_TABBAR_COMPACT1_ENTER,
      exit: PANE_TABBAR_COMPACT1_EXIT,
    },
    {
      name: "compact1/micro",
      wider: "compact1",
      narrower: "micro",
      enter: PANE_TABBAR_MICRO_ENTER,
      exit: PANE_TABBAR_MICRO_EXIT,
    },
  ];

  it("uses the specified non-overlapping hysteresis bands", () => {
    expect({
      slim: [PANE_TABBAR_SLIM_ENTER, PANE_TABBAR_SLIM_EXIT],
      compact: [PANE_TABBAR_COMPACT_ENTER, PANE_TABBAR_COMPACT_EXIT],
      compact3: [PANE_TABBAR_COMPACT3_ENTER, PANE_TABBAR_COMPACT3_EXIT],
      compact2: [PANE_TABBAR_COMPACT2_ENTER, PANE_TABBAR_COMPACT2_EXIT],
      compact1: [PANE_TABBAR_COMPACT1_ENTER, PANE_TABBAR_COMPACT1_EXIT],
      micro: [PANE_TABBAR_MICRO_ENTER, PANE_TABBAR_MICRO_EXIT],
    }).toEqual({
      slim: [560, 600],
      compact: [360, 400],
      compact3: [250, 290],
      compact2: [210, 238],
      compact1: [170, 198],
      micro: [130, 158],
    });
    for (const boundary of boundaries) {
      expect(boundary.exit - boundary.enter).toBeGreaterThanOrEqual(28);
    }
    for (let index = 1; index < boundaries.length; index += 1) {
      expect(boundaries[index].exit).toBeLessThan(boundaries[index - 1].enter);
    }
  });

  for (const boundary of boundaries) {
    it(`applies ${boundary.name} hysteresis in both directions`, () => {
      expect(resolvePaneTabBarMode(boundary.enter - 1, boundary.wider)).toBe(boundary.narrower);
      expect(resolvePaneTabBarMode(boundary.enter, boundary.wider)).toBe(boundary.wider);
      expect(resolvePaneTabBarMode(boundary.enter, boundary.narrower)).toBe(boundary.narrower);
      expect(resolvePaneTabBarMode(boundary.exit - 1, boundary.wider)).toBe(boundary.wider);
      expect(resolvePaneTabBarMode(boundary.exit - 1, boundary.narrower)).toBe(boundary.narrower);
      expect(resolvePaneTabBarMode(boundary.exit, boundary.narrower)).toBe(boundary.wider);
    });
  }

  it("crosses multiple tiers in one measurement", () => {
    const modes: PaneTabBarMode[] = [
      "full", "slim", "compact", "compact3", "compact2", "compact1", "micro",
    ];
    const stableWidths: Array<[number, PaneTabBarMode]> = [
      [700, "full"],
      [500, "slim"],
      [320, "compact"],
      [244, "compact3"],
      [204, "compact2"],
      [164, "compact1"],
      [120, "micro"],
    ];

    for (const previous of modes) {
      for (const [width, expected] of stableWidths) {
        expect(resolvePaneTabBarMode(width, previous)).toBe(expected);
      }
    }
  });

  it("is monotonic for every previous mode across positive widths", () => {
    const modes: PaneTabBarMode[] = [
      "full", "slim", "compact", "compact3", "compact2", "compact1", "micro",
    ];
    const rank = new Map(modes.map((mode, index) => [mode, index]));

    for (const previous of modes) {
      let previousRank = Number.POSITIVE_INFINITY;
      for (let width = 1; width <= 700; width += 1) {
        const currentRank = rank.get(resolvePaneTabBarMode(width, previous));
        expect(currentRank).toBeDefined();
        expect(currentRank!).toBeLessThanOrEqual(previousRank);
        previousRank = currentRank!;
      }
    }
  });

  it("ignores zero-width measurements from hidden or unmounted bars", () => {
    for (const mode of [
      "full", "slim", "compact", "compact3", "compact2", "compact1", "micro",
    ] as const) {
      expect(resolvePaneTabBarMode(0, mode)).toBe(mode);
    }
  });
});

describe("resolvePaneTabBarActions", () => {
  const allActions: PaneTabBarActionId[] = [
    "new-tab",
    "search",
    "publish",
    "split-right",
    "split-down",
    "zoom",
    "dashboard",
    "close",
  ];
  const modes: PaneTabBarMode[] = [
    "full", "slim", "compact", "compact3", "compact2", "compact1", "micro",
  ];
  const visibleByMode: Record<PaneTabBarMode, PaneTabBarActionId[]> = {
    full: ["split-right", "split-down", "zoom", "close"],
    slim: ["split-right", "split-down", "zoom", "close"],
    compact: ["split-right", "zoom", "close"],
    compact3: ["zoom"],
    compact2: [],
    compact1: [],
    micro: [],
  };

  for (const mode of modes) {
    for (const showPublish of [true, false]) {
      it(`partitions ${mode} actions when showPublish=${showPublish}`, () => {
        const expectedAll = allActions.filter((action) => action !== "publish" || showPublish);
        const expectedVisible = visibleByMode[mode].filter(
          (action) => action !== "publish" || showPublish,
        );
        const expected = {
          visible: expectedVisible,
          overflow: expectedAll.filter((action) => !expectedVisible.includes(action)),
        };
        const result = resolvePaneTabBarActions(mode, { showPublish });

        expect(result).toEqual(expected);
        expect(result.visible.filter((action) => result.overflow.includes(action))).toEqual([]);
        expect([...result.visible, ...result.overflow].sort()).toEqual([...expectedAll].sort());
      });
    }
  }

  it("keeps the whole-place close on the right edge from compact up", () => {
    expect(modes.map((mode) => resolvePaneTabBarActions(mode, { showPublish: true }).visible.includes("close")))
      .toEqual([true, true, true, false, false, false, false]);
  });

  it.each(["compact2", "compact1"] as const)(
    "moves publish into the overflow in the narrow %s mode",
    (mode) => {
      const { visible, overflow } = resolvePaneTabBarActions(mode, { showPublish: true });
      expect(overflow).toContain("publish");
      expect(visible).not.toContain("publish");
    },
  );

  it("folds priority actions in the requested order", () => {
    const visibleSets = modes.map(
      (mode) => resolvePaneTabBarActions(mode, { showPublish: true }).visible,
    );
    const removedPerTier = visibleSets.slice(1).map((visible, index) =>
      visibleSets[index].filter((action) => !visible.includes(action)),
    );

    expect(removedPerTier).toEqual([
      [], ["split-down"], ["split-right", "close"], ["zoom"], [], [],
    ]);
    for (let index = 1; index < visibleSets.length; index += 1) {
      expect(visibleSets[index].every((action) => visibleSets[index - 1].includes(action)))
        .toBe(true);
    }
  });
});

describe("formatHiddenTabCount", () => {
  it("shows hidden counts at wide widths", () => {
    expect(formatHiddenTabCount(1, "full")).toBe("裏 1");
    expect(formatHiddenTabCount(5, "slim")).toBe("裏 5");
  });
  it("keeps counts compact at narrow widths", () => {
    expect(formatHiddenTabCount(1, "compact2")).toBe("+1");
    expect(formatHiddenTabCount(5, "compact1")).toBe("+5");
    expect(formatHiddenTabCount(12, "micro")).toBe("+12");
  });
});

describe("resolveActiveAgentLabel", () => {
  it("prefers live agent kind after Codex starts from the launch menu", () => {
    expect(resolveActiveAgentLabel("shell-starter", "codex", "Launch Menu")).toBe("Codex");
    expect(resolveActiveAgentLabel("shell-starter", "claude", "Launch Menu")).toBe("Claude Code");
  });

  it("uses intuitive Japanese labels for launcher and shell surfaces", () => {
    expect(resolveActiveAgentLabel("shell-starter", undefined)).toBe("起動メニュー");
    expect(resolveActiveAgentLabel("shell", undefined)).toBe("シェル");
  });
});

describe("resolvePaneTabMenuRows", () => {
  const attention = (sessionId: string, attentionId: string, kind: SessionAttention["kind"], occurrenceOrder: number): SessionAttention => ({
    sessionId,
    attentionId,
    kind,
    detail: null,
    sessionRevision: 1,
    uiState: kind === "done" ? "done" : "waiting",
    stateSince: occurrenceOrder,
    occurrenceOrder,
  });

  it("hoists attention tabs in occurrence order and lists each tab exactly once", () => {
    const tabs = [
      tab({ id: "tab-a", sessionId: "session-a" }),
      tab({ id: "tab-b", sessionId: "session-b" }),
      tab({ id: "tab-c", sessionId: "session-c" }),
      tab({ id: "tab-d", sessionId: "session-d" }),
    ];
    const rows = resolvePaneTabMenuRows(tabs, {
      "session-a": attention("session-a", "attention-a", "done", 3),
      "session-b": attention("session-b", "attention-b", "approval", 1),
      "session-c": attention("session-c", "attention-c", "error", 2),
    }, new Map());

    expect(rows.map((row) => row.tab.id)).toEqual(["tab-b", "tab-c", "tab-a", "tab-d"]);
    expect(rows.map((row) => row.hoisted)).toEqual([true, true, false, false]);
    expect(rows.every((row) => !row.isPinned)).toBe(true);
    expect(rows.map((row) => row.category)).toEqual(["waiting", "error", null, null]);
    expect(new Set(rows.map((row) => row.tab.id)).size).toBe(tabs.length);
  });

  it("keeps tab-strip order when nothing needs attention", () => {
    const tabs = [
      tab({ id: "tab-a", sessionId: "session-a" }),
      tab({ id: "tab-b", sessionId: "session-b" }),
    ];
    const rows = resolvePaneTabMenuRows(tabs, {}, new Map());

    expect(rows.map((row) => row.tab.id)).toEqual(["tab-a", "tab-b"]);
    expect(rows.every((row) => !row.hoisted && !row.isPinned && row.category === null)).toBe(true);
  });

  it("puts the pinned tab first even when another tab has unseen attention", () => {
    const tabs = [
      tab({ id: "tab-a", sessionId: "session-a" }),
      tab({ id: "tab-b", sessionId: "session-b" }),
      tab({ id: "tab-c", sessionId: "session-c" }),
    ];
    const rows = resolvePaneTabMenuRows(tabs, {
      "session-b": attention("session-b", "attention-b", "approval", 1),
      "session-c": attention("session-c", "attention-c", "error", 2),
    }, new Map(), "tab-c");

    expect(rows.map((row) => row.tab.id)).toEqual(["tab-c", "tab-b", "tab-a"]);
    expect(rows.map((row) => row.isPinned)).toEqual([true, false, false]);
    expect(rows.map((row) => row.hoisted)).toEqual([false, true, false]);
    // The pinned row keeps its attention category so the badge still renders,
    // and it appears exactly once despite also needing attention.
    expect(rows.map((row) => row.category)).toEqual(["error", "waiting", null]);
    expect(new Set(rows.map((row) => row.tab.id)).size).toBe(tabs.length);
  });

  it("ignores a pinned id that no longer names a tab", () => {
    const tabs = [
      tab({ id: "tab-a", sessionId: "session-a" }),
      tab({ id: "tab-b", sessionId: "session-b" }),
    ];
    const rows = resolvePaneTabMenuRows(tabs, {}, new Map(), "tab-gone");

    expect(rows.map((row) => row.tab.id)).toEqual(["tab-a", "tab-b"]);
    expect(rows.every((row) => !row.isPinned)).toBe(true);
  });
});

describe("header zoom visibility", () => {
  it("keeps zoom on the header only at the four wider tiers", () => {
    const modes: PaneTabBarMode[] = ["full", "slim", "compact", "compact3", "compact2", "compact1", "micro"];
    expect(modes.map((mode) => resolvePaneTabBarActions(mode, { showPublish: false }).visible.includes("zoom")))
      .toEqual([true, true, true, true, false, false, false]);
  });
});

describe("header split visibility", () => {
  it("folds the opt-in down split below slim and the right split below compact", () => {
    const modes: PaneTabBarMode[] = ["full", "slim", "compact", "compact3", "compact2", "compact1", "micro"];
    const visible = (action: PaneTabBarActionId) =>
      modes.map((mode) => resolvePaneTabBarActions(mode, { showPublish: false }).visible.includes(action));
    expect(visible("split-right")).toEqual([true, true, true, false, false, false, false]);
    expect(visible("split-down")).toEqual([true, true, false, false, false, false, false]);
  });
});

describe("resolvePaneTabMenuLeft", () => {
  it("right-aligns the menu with its trigger when there is room", () => {
    expect(resolvePaneTabMenuLeft(400, 440, 280)).toBe(160);
  });

  it("left-aligns instead of drifting off the left edge in a narrow pane", () => {
    expect(resolvePaneTabMenuLeft(20, 60, 280)).toBe(20);
  });
});

describe("shouldMarkAttentionSeen", () => {
  it("marks only a displayed active tab with canonical attention", () => {
    expect(shouldMarkAttentionSeen(true, "tab-a", "attention-a")).toBe(true);
    expect(shouldMarkAttentionSeen(false, "tab-a", "attention-a")).toBe(false);
    expect(shouldMarkAttentionSeen(true, undefined, "attention-a")).toBe(false);
    expect(shouldMarkAttentionSeen(true, "tab-a", null)).toBe(false);
  });
});

describe("shouldCloseTabOnAuxClick", () => {
  it("closes on the middle button only", () => {
    expect(shouldCloseTabOnAuxClick(1, false, false)).toBe(true);
    expect(shouldCloseTabOnAuxClick(0, false, false)).toBe(false);
    expect(shouldCloseTabOnAuxClick(2, false, false)).toBe(false);
  });

  it("declines while the pill is renaming, so the text field keeps the button", () => {
    expect(shouldCloseTabOnAuxClick(1, true, false)).toBe(false);
  });

  it("declines on the pin, duplicate and close controls the pill hosts", () => {
    expect(shouldCloseTabOnAuxClick(1, false, true)).toBe(false);
  });
});

describe("hidden-tab severity aggregation", () => {
  it("lets errors dominate waiting and working", () => {
    expect(resolveHiddenTabStatus(["working", "waiting", "error"])).toBe("error");
    expect(resolveHiddenTabStatus(["error", "working", "waiting"])).toBe("error");
    expect(resolveHiddenTabStatus([null, "error"])).toBe("error");
    expect(resolveHiddenTabStatus(["error"])).toBe("error");
  });
  it("keeps waiting ahead of working independently of order", () => {
    expect(resolveHiddenTabStatus(["working", "waiting"])).toBe("waiting");
    expect(resolveHiddenTabStatus(["waiting", "working"])).toBe("waiting");
    expect(resolveHiddenTabStatus([null, "waiting"])).toBe("waiting");
  });
  it("shows working only when heavier states are absent", () => {
    expect(resolveHiddenTabStatus([null, "working"])).toBe("working");
    expect(resolveHiddenTabStatus(["working", null])).toBe("working");
    expect(resolveHiddenTabStatus(["working", "working"])).toBe("working");
    expect(resolveHiddenTabStatus(["working"])).toBe("working");
  });
  it("hides severity for empty and idle hidden sessions", () => {
    expect(resolveHiddenTabStatus([])).toBeNull();
    expect(resolveHiddenTabStatus([null, null])).toBeNull();
  });
});
