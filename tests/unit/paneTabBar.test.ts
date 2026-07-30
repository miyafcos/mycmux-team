import { describe, expect, it } from "vitest";
import type { PaneTab } from "../../src/types";
import {
  formatTabPosition,
  isTabActivationKey,
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
  resolvePaneTabMenuSections,
  resolvePaneTabBarMode,
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
    "publish",
    "split-right",
    "split-down",
    "zoom",
    "close",
  ];
  const modes: PaneTabBarMode[] = [
    "full", "slim", "compact", "compact3", "compact2", "compact1", "micro",
  ];
  const visibleByMode: Record<PaneTabBarMode, PaneTabBarActionId[]> = {
    full: allActions,
    slim: ["publish", "split-right", "zoom", "close"],
    compact: ["publish", "split-right", "zoom", "close"],
    compact3: ["split-right", "zoom", "close"],
    compact2: ["zoom", "close"],
    compact1: ["close"],
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

  it("folds priority actions one at a time in the requested order", () => {
    const visibleSets = modes.map(
      (mode) => resolvePaneTabBarActions(mode, { showPublish: true }).visible,
    );
    const removedPerTier = visibleSets.slice(1).map((visible, index) =>
      visibleSets[index].filter((action) => !visible.includes(action)),
    );

    expect(removedPerTier).toEqual([
      ["new-tab", "split-down"],
      [],
      ["publish"],
      ["split-right"],
      ["zoom"],
      ["close"],
    ]);
    for (let index = 1; index < visibleSets.length; index += 1) {
      expect(visibleSets[index].every((action) => visibleSets[index - 1].includes(action)))
        .toBe(true);
    }
  });
});

describe("formatTabPosition", () => {
  it("formats a 1-based position over the total", () => {
    expect(formatTabPosition(1, 5)).toBe("2/5");
    expect(formatTabPosition(0, 1)).toBe("1/1");
  });

  it("falls back to the first position when the active index is unknown", () => {
    expect(formatTabPosition(-1, 4)).toBe("1/4");
    expect(formatTabPosition(9, 4)).toBe("1/4");
    expect(formatTabPosition(0, 0)).toBe("1/1");
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

describe("resolvePaneTabMenuSections", () => {
  it("adds an occurrence-ordered attention section without changing all-tab order", () => {
    const tabs = [
      tab({ id: "tab-a", sessionId: "session-a" }),
      tab({ id: "tab-b", sessionId: "session-b" }),
      tab({ id: "tab-c", sessionId: "session-c" }),
    ];
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
    const sections = resolvePaneTabMenuSections(tabs, {
      "session-a": attention("session-a", "attention-a", "done", 3),
      "session-b": attention("session-b", "attention-b", "approval", 1),
      "session-c": attention("session-c", "attention-c", "error", 2),
    }, new Map());

    expect(sections.attention.map(({ tab: item }) => item.id)).toEqual(["tab-b", "tab-c", "tab-a"]);
    expect(sections.all.map((item) => item.id)).toEqual(["tab-a", "tab-b", "tab-c"]);
    expect(sections.all).toBe(tabs);
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
