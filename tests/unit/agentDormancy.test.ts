import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_DORMANT_MINUTES_STORAGE_KEY,
  DEFAULT_AGENT_DORMANT_MINUTES,
  isAgentRestProcess,
  isEffectivelyWorking,
  observeDormancyActivity,
  readDormantThresholdMs,
  resolveDormantAction,
  resolveDormantResumeIdentity,
  resolveDormantThresholdMs,
  resolveRenderedTabId,
  shouldDormantSession,
  type DormantSessionCandidate,
} from "../../src/lib/agentDormancy";
import type { PaneTab } from "../../src/types";

const NOW = 10_000_000;
const THRESHOLD_MS = 120 * 60 * 1_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

function candidate(overrides: Partial<DormantSessionCandidate> = {}): DormantSessionCandidate {
  return {
    agentKind: "claude",
    resumeSessionId: "agent-session",
    visible: false,
    mounted: false,
    processStatus: "idle",
    processName: null,
    lastActivityAt: NOW - THRESHOLD_MS,
    thresholdMs: THRESHOLD_MS,
    ...overrides,
  };
}

describe("agent dormancy threshold", () => {
  it("uses 120 minutes by default and disables at zero", () => {
    expect(resolveDormantThresholdMs(undefined)).toBe(DEFAULT_AGENT_DORMANT_MINUTES * 60 * 1_000);
    expect(resolveDormantThresholdMs("0")).toBe(0);
  });

  it("falls back for invalid or negative values", () => {
    expect(resolveDormantThresholdMs("invalid")).toBe(THRESHOLD_MS);
    expect(resolveDormantThresholdMs("-1")).toBe(THRESHOLD_MS);
  });

  it.each([
    [null, THRESHOLD_MS],
    ["0", 0],
    ["30", 30 * 60 * 1_000],
    ["invalid", THRESHOLD_MS],
  ])("reads localStorage override %s", (raw, expected) => {
    const getItem = vi.fn(() => raw);
    vi.stubGlobal("window", { localStorage: { getItem } });

    expect(readDormantThresholdMs()).toBe(expected);
    expect(getItem).toHaveBeenCalledWith(AGENT_DORMANT_MINUTES_STORAGE_KEY);
  });

  it("falls back when localStorage access throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("storage blocked");
        },
      },
    });

    expect(readDormantThresholdMs()).toBe(THRESHOLD_MS);
  });
});

describe("resolveDormantAction", () => {
  it("kills an eligible unmounted session", () => {
    expect(resolveDormantAction(candidate(), NOW)).toBe("kill");
  });

  it("evicts only the cache for an eligible mounted session", () => {
    expect(resolveDormantAction(candidate({ mounted: true }), NOW)).toBe("evictCache");
  });

  it("does nothing before the threshold or while visible", () => {
    expect(resolveDormantAction(
      candidate({ lastActivityAt: NOW - THRESHOLD_MS + 1 }),
      NOW,
    )).toBe("none");
    expect(resolveDormantAction(candidate({ visible: true, mounted: true }), NOW)).toBe("none");
  });

  it("dormants a resting claude process even when the backend reports working", () => {
    expect(resolveDormantAction(candidate({
      processStatus: "working",
      processName: "claude.exe",
    }), NOW)).toBe("kill");
  });

  it("protects an active tool and an unknown working process", () => {
    expect(resolveDormantAction(candidate({
      processStatus: "working",
      processName: "git.exe",
    }), NOW)).toBe("none");
    expect(resolveDormantAction(candidate({
      processStatus: "working",
      processName: null,
    }), NOW)).toBe("none");
  });

  it("dormants a resting codex MCP process and still respects visibility", () => {
    expect(resolveDormantAction(candidate({
      processStatus: "working",
      processName: "node_repl.exe",
    }), NOW)).toBe("kill");
    expect(resolveDormantAction(candidate({
      processStatus: "working",
      processName: "node_repl.exe",
      visible: true,
    }), NOW)).toBe("none");
  });

  it("evicts a mounted resting agent before killing it", () => {
    expect(resolveDormantAction(candidate({
      processStatus: "working",
      processName: "claude.exe",
      mounted: true,
    }), NOW)).toBe("evictCache");
  });

  it("does nothing for disabled, shell, or non-resumable candidates", () => {
    expect(resolveDormantAction(candidate({ thresholdMs: 0 }), NOW)).toBe("none");
    expect(resolveDormantAction(candidate({ agentKind: null }), NOW)).toBe("none");
    expect(resolveDormantAction(candidate({ resumeSessionId: null }), NOW)).toBe("none");
  });
});

describe("shouldDormantSession", () => {
  it("dormants at the exact threshold", () => {
    expect(shouldDormantSession(candidate(), NOW)).toBe(true);
  });

  it("does not dormant one millisecond before the threshold", () => {
    expect(shouldDormantSession(candidate({ lastActivityAt: NOW - THRESHOLD_MS + 1 }), NOW)).toBe(false);
  });

  it("does not dormant an unknown working session", () => {
    expect(shouldDormantSession(candidate({
      processStatus: "working",
      processName: null,
    }), NOW)).toBe(false);
  });

  it("does not dormant a visible or mounted session", () => {
    expect(shouldDormantSession(candidate({ visible: true }), NOW)).toBe(false);
    expect(shouldDormantSession(candidate({ mounted: true }), NOW)).toBe(false);
  });

  it("is true only for the kill action", () => {
    expect(shouldDormantSession(candidate(), NOW)).toBe(true);
    expect(shouldDormantSession(candidate({ mounted: true }), NOW)).toBe(false);
  });

  it("does not dormant shell or non-resumable tabs", () => {
    expect(shouldDormantSession(candidate({ agentKind: null }), NOW)).toBe(false);
    expect(shouldDormantSession(candidate({ resumeSessionId: null }), NOW)).toBe(false);
  });

  it("does not dormant when the threshold is disabled", () => {
    expect(shouldDormantSession(candidate({ thresholdMs: 0 }), NOW)).toBe(false);
  });
});

describe("effective agent work", () => {
  it.each([
    "claude",
    "CLAUDE.EXE",
    "codex.exe",
    "node",
    "node_repl.exe",
  ])("recognizes the resident agent process %s", (name) => {
    expect(isAgentRestProcess(name)).toBe(true);
  });

  it.each([null, undefined, "", "git.exe", "python.exe"])(
    "does not classify %s as a resident agent process",
    (name) => {
      expect(isAgentRestProcess(name)).toBe(false);
    },
  );

  it("treats only non-agent working processes as effectively working", () => {
    expect(isEffectivelyWorking(candidate({
      processStatus: "working",
      processName: "cargo.exe",
    }))).toBe(true);
    expect(isEffectivelyWorking(candidate({
      processStatus: "working",
      processName: "codex.exe",
    }))).toBe(false);
    expect(isEffectivelyWorking(candidate({
      processStatus: "working",
      processName: null,
    }))).toBe(true);
  });
});

describe("dormancy activity observation", () => {
  it("seeds at first observation and resets when output advances", () => {
    const first = observeDormancyActivity(undefined, 10, undefined, 1_000);
    expect(first).toEqual({ endOffset: 10, lastActivityAt: 1_000 });
    expect(observeDormancyActivity(first, 11, undefined, 2_000)).toEqual({
      endOffset: 11,
      lastActivityAt: 2_000,
    });
  });

  it("retains an unchanged output time but advances for a frontend write", () => {
    const previous = { endOffset: 10, lastActivityAt: 1_000 };
    expect(observeDormancyActivity(previous, 10, undefined, 3_000)).toEqual(previous);
    expect(observeDormancyActivity(previous, 10, 2_500, 3_000)).toEqual({
      endOffset: 10,
      lastActivityAt: 2_500,
    });
  });
});

describe("dormant resume identity", () => {
  it("accepts resumable claude and codex tabs only", () => {
    const base: PaneTab = {
      id: "tab",
      sessionId: "terminal",
      agentId: "shell",
    };
    expect(resolveDormantResumeIdentity({
      ...base,
      agentKind: "claude",
      claudeSessionId: "claude-session",
    })).toEqual({ agentKind: "claude", resumeSessionId: "claude-session" });
    expect(resolveDormantResumeIdentity({
      ...base,
      agentKind: "codex",
      agentSessionId: "codex-session",
    })).toEqual({ agentKind: "codex", resumeSessionId: "codex-session" });
    expect(resolveDormantResumeIdentity(base)).toBeNull();
  });
});

describe("rendered terminal tab", () => {
  it("matches TerminalPane's first-tab fallback for a stale activeTabId", () => {
    expect(resolveRenderedTabId({
      activeTabId: "deleted-tab",
      tabs: [
        { id: "fallback-tab", sessionId: "session-1", agentId: "shell" },
        { id: "other-tab", sessionId: "session-2", agentId: "shell" },
      ],
    })).toBe("fallback-tab");
  });
});
