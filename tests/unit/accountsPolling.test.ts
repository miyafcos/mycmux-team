import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pollPlan } from "../../src/hooks/useAccountsPolling";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("account polling cadence", () => {
  it("enforces the 60s/180s schedule and the documented focus exception", () => {
    expect(pollPlan({ nowMs: 0, lastCliAt: null, lastUsageAt: null, trigger: "mount" })).toEqual({
      cli: true,
      usage: true,
    });
    expect(
      pollPlan({ nowMs: 59_999, lastCliAt: 0, lastUsageAt: 0, trigger: "cli-interval" }),
    ).toEqual({ cli: false, usage: false });
    expect(
      pollPlan({ nowMs: 60_000, lastCliAt: 0, lastUsageAt: 0, trigger: "cli-interval" }),
    ).toEqual({ cli: true, usage: false });
    expect(
      pollPlan({ nowMs: 179_999, lastCliAt: 0, lastUsageAt: 0, trigger: "usage-interval" }),
    ).toEqual({ cli: false, usage: false });
    expect(
      pollPlan({ nowMs: 180_000, lastCliAt: 0, lastUsageAt: 0, trigger: "usage-interval" }),
    ).toEqual({ cli: false, usage: true });
    // Focus always refreshes the cheap CLI read; usage waits out its own floor.
    expect(pollPlan({ nowMs: 59_999, lastCliAt: 59_999, lastUsageAt: 0, trigger: "focus" })).toEqual(
      { cli: true, usage: false },
    );
    expect(pollPlan({ nowMs: 60_000, lastCliAt: 60_000, lastUsageAt: 0, trigger: "focus" })).toEqual(
      { cli: true, usage: true },
    );
  });

  it("keeps polling in one mounted hook with complete timer and focus cleanup", () => {
    const hook = source("src/hooks/useAccountsPolling.ts");
    const titleBar = source("src/components/layout/TitleBar.tsx");

    expect(titleBar.match(/useAccountsPolling\(\)/g)).toHaveLength(1);
    expect(hook.match(/window\.setTimeout/g)).toHaveLength(2);
    expect(hook.match(/window\.clearTimeout/g)).toHaveLength(4);
    expect(hook).toContain('window.addEventListener("focus", onFocus)');
    expect(hook).toContain('window.removeEventListener("focus", onFocus)');
    expect(hook).toContain("cliInFlight.current");
    expect(hook).toContain("usageInFlight.current");
  });
});
