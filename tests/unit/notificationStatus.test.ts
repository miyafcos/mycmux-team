import { describe, expect, it, vi } from "vitest";
import { WORKING_INDICATOR_PATTERNS } from "../../src/components/terminal/XTermWrapper";
import { deriveDisplayStatus, dispatchStateLabel } from "../../src/lib/notificationStatus";
import type { PaneMetadata } from "../../src/stores/paneMetadataStore";

describe("deriveDisplayStatus", () => {
  const now = 1_725_000_000_000;

  it.each([
    [undefined, "idle"],
    [{ processIsShell: true }, "idle"],
    [{ processIsShell: false }, "idle"],
    [{ processIsShell: false, outputActive: true }, "working"],
    [{ processIsShell: false, workingPatternVisible: true }, "working"],
    [{ processIsShell: true, outputActive: true, workingPatternVisible: true }, "idle"],
    [{ agentStatus: "waiting" }, "waiting"],
    [{ agentStatus: "waiting", processIsShell: false, outputActive: true }, "waiting"],
    [{ processIsShell: false, backendLastOutputAt: now - 15_000 }, "working"],
    [{ processIsShell: false, backendLastOutputAt: now - 20_000 }, "idle"],
    [{ agentStatus: "waiting", processIsShell: false, backendLastOutputAt: now - 1 }, "waiting"],
    [{ processIsShell: true, backendLastOutputAt: now - 1 }, "idle"],
  ] as Array<[PaneMetadata | undefined, "waiting" | "working" | "idle"]>)(
    "derives %j as %s",
    (meta, expected) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      expect(deriveDisplayStatus(meta)).toBe(expected);
      vi.restoreAllMocks();
    },
  );
});

describe("dispatchStateLabel", () => {
  it.each([
    "CLOSED", "DONE", "DONE_NEEDS_REVIEW", "ASK", "NO_LOG", "RUNNING", "RATE_LIMITED", "STALL",
  ] as const)("does not expose the internal enum %s", (state) => {
    const label = dispatchStateLabel(state);
    expect(label).not.toBe(state);
    // Every label is user-facing Japanese, never a raw enum or placeholder.
    expect(label).toMatch(/[぀-ヿ一-鿿]/);
  });
});

describe("WORKING_INDICATOR_PATTERNS", () => {
  const matchesWorkingPattern = (line: string): boolean => (
    WORKING_INDICATOR_PATTERNS.some((pattern) => pattern.test(line))
  );

  it("matches a Claude-style working indicator", () => {
    expect(matchesWorkingPattern("Thinking... (esc to interrupt)")).toBe(true);
  });

  it("does not match a plain prompt", () => {
    expect(matchesWorkingPattern("Ready for your next instruction >")).toBe(false);
  });
});
