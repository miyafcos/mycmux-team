import { describe, expect, it } from "vitest";
import {
  isDeclaredTab,
  isRestorableTab,
  KNOWN_LIFECYCLES,
  partitionTabsForRestore,
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
