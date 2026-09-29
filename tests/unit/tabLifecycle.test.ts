import { describe, expect, it } from "vitest";
import {
  isDeclaredTab,
  isRestorableTab,
  KNOWN_LIFECYCLES,
  partitionTabsForRestore,
  tabHasPty,
} from "../../src/lib/tabLifecycle";
import type { PaneTab } from "../../src/types/workspace";

const tab = (id: string, lifecycle?: string): PaneTab => ({ id, sessionId: `s-${id}`, agentId: "shell", ...(lifecycle === undefined ? {} : { lifecycle: lifecycle as "declared" }) });

describe("tabLifecycle", () => {
  it("keeps missing lifecycle restorable and separates declared", () => {
    const result = partitionTabsForRestore([tab("existing"), tab("declared", "declared")]);
    expect(result.restorable.map((value) => value.id)).toEqual(["existing"]);
    expect(result.declared.map((value) => value.id)).toEqual(["declared"]);
    expect(result.restorable.some(isDeclaredTab)).toBe(false);
  });

  it("quarantines unknown lifecycle values", () => {
    const unknown = { ...tab("unknown"), lifecycle: "future" } as PaneTab;
    expect(partitionTabsForRestore([unknown])).toEqual({ restorable: [], declared: [], quarantined: [unknown] });
  });

  it("quarantines lifecycle null after a JSON round trip", () => {
    const roundTripped = JSON.parse(JSON.stringify({ ...tab("null"), lifecycle: null })) as PaneTab;
    expect(partitionTabsForRestore([roundTripped])).toEqual({
      restorable: [],
      declared: [],
      quarantined: [roundTripped],
    });
  });

  it("keeps declared launch fields quarantined from restore", () => {
    const declared = { ...tab("declared"), lifecycle: "declared", launchEnv: { SAFE: "1" } } as PaneTab;
    const result = partitionTabsForRestore([declared]);
    expect(result.declared).toEqual([declared]);
    expect(result.restorable).toEqual([]);
    expect(KNOWN_LIFECYCLES).toEqual(["declared"]);
  });

  it("classifies restorable tabs via the predicate", () => {
    // The compile-time proof that declared tabs cannot reach launch-typed
    // APIs lives in src/lib/tabLifecycle.typecheck.ts (checked by tsc);
    // this test file is not type-checked by the root tsconfig.
    expect(isRestorableTab(tab("existing"))).toBe(true);
  });
});

describe("tabHasPty", () => {
  it("excludes the tab types that own no process", () => {
    // A web tab is a child webview and a launcher tab is a React picker.
    // Reporting either as a terminal made a delegation script's `send` look
    // delivered while landing nowhere.
    expect(tabHasPty({ type: "web" })).toBe(false);
    expect(tabHasPty({ type: "launcher" })).toBe(false);
  });

  it("keeps terminals, including the ones that predate the field", () => {
    expect(tabHasPty({ type: "terminal" })).toBe(true);
    expect(tabHasPty({})).toBe(true);
    expect(tabHasPty({ type: null })).toBe(true);
  });

  it("leaves browser and online on the true side, as they were", () => {
    // Not an endorsement: they hold no PTY either, but moving them is a
    // behaviour change of its own and is deliberately not made here.
    expect(tabHasPty({ type: "browser" })).toBe(true);
    expect(tabHasPty({ type: "online" })).toBe(true);
  });
});
