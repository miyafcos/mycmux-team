import { describe, expect, it } from "vitest";
import { WORKING_INDICATOR_PATTERNS } from "../../src/components/terminal/XTermWrapper";
import { deriveDisplayStatus } from "../../src/lib/notificationStatus";
import type { PaneMetadata } from "../../src/stores/paneMetadataStore";

describe("deriveDisplayStatus", () => {
  it.each([
    [undefined, "idle"],
    [{ processIsShell: true }, "idle"],
    [{ processIsShell: false }, "idle"],
    [{ processIsShell: false, outputActive: true }, "working"],
    [{ processIsShell: false, workingPatternVisible: true }, "working"],
    [{ processIsShell: true, outputActive: true, workingPatternVisible: true }, "idle"],
    [{ agentStatus: "waiting" }, "waiting"],
    [{ agentStatus: "waiting", processIsShell: false, outputActive: true }, "waiting"],
  ] as Array<[PaneMetadata | undefined, "waiting" | "working" | "idle"]>)(
    "derives %j as %s",
    (meta, expected) => {
      expect(deriveDisplayStatus(meta)).toBe(expected);
    },
  );
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
