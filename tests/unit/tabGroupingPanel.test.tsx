import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TabGroupingButton } from "../../src/components/layout/TabGroupingButton";
import {
  groupingCommitFailureMessage,
  groupingPreviewFailureMessage,
  groupingStepStates,
  groupingPrepareFailureMessage,
  groupingUndoFailureMessage,
  nextGroupingStep,
  orderGroupingPlansForDisplay,
  previousGroupingStep,
  shouldInvalidateGroupingTicket,
  TabGroupingPanel,
} from "../../src/components/layout/TabGroupingPanel";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import type { GroupingPlan } from "../../src/components/layout/tabGrouping";

describe("TabGroupingPanel", () => {
  it("renders the three-mode header and Japanese copy", () => {
    const html = renderToStaticMarkup(
      <TabGroupingPanel open visible onClose={() => {}} />,
    );
    expect(html).toContain(tabGroupingStrings.title);
    expect(html).toContain(tabGroupingStrings.stepCompare);
    expect(html).toContain(tabGroupingStrings.stepEdit);
    expect(html).toContain(tabGroupingStrings.stepConfirm);
    expect(html).toContain(tabGroupingStrings.stepConfirm);
    expect(html).toContain(tabGroupingStrings.analyzeAgain);
    expect(html).toContain('aria-label="手順"');
  });
});

describe("TabGroupingButton", () => {
  it("exposes the dashboard entry in Japanese", () => {
    const html = renderToStaticMarkup(<TabGroupingButton />);
    expect(html).toContain(tabGroupingStrings.buttonLabel);
    expect(html).toContain("tab-grouping-panel");
  });
});

describe("TabGroupingPanel boundary helpers", () => {
  it.each([
    [{ preparedLayoutRevision: null, currentLayoutRevision: 2, applying: false, applied: false }, false],
    [{ preparedLayoutRevision: 2, currentLayoutRevision: 2, applying: false, applied: false }, false],
    [{ preparedLayoutRevision: 2, currentLayoutRevision: 3, applying: false, applied: false }, true],
    [{ preparedLayoutRevision: 2, currentLayoutRevision: 3, applying: true, applied: false }, false],
    [{ preparedLayoutRevision: 2, currentLayoutRevision: 3, applying: false, applied: true }, false],
  ] as const)("decides whether to invalidate a prepared ticket", (input, expected) => {
    expect(shouldInvalidateGroupingTicket(input)).toBe(expected);
  });

  it("maps every commit failure kind to the ruled copy", () => {
    type Failure = Parameters<typeof groupingCommitFailureMessage>[0];
    type Kind = Failure["kind"];
    const expected = {
      preview_stale: tabGroupingStrings.applyBlocked,
      plan_changed: tabGroupingStrings.applyPlanChanged,
      invalid_input: tabGroupingStrings.applyInvalidInput,
      commit_mismatch: tabGroupingStrings.applyMismatch,
      rollback_failed: tabGroupingStrings.statusPoisoned,
      boundary_poisoned: tabGroupingStrings.statusPoisoned,
      schema_incompatible: tabGroupingStrings.applySchemaIncompatible,
      operation_in_progress: tabGroupingStrings.applyOperationInProgress,
    } satisfies Record<Kind, string>;

    for (const kind of Object.keys(expected) as Kind[]) {
      expect(groupingCommitFailureMessage({ ok: false, kind, errors: [] })).toBe(expected[kind]);
    }
  });

  it("maps every prepare failure kind and the compile fallback", () => {
    type Failure = Parameters<typeof groupingPrepareFailureMessage>[0];
    type Kind = NonNullable<Failure["kind"]>;
    const expected = {
      schema_incompatible: tabGroupingStrings.applySchemaIncompatible,
      boundary_poisoned: tabGroupingStrings.statusPoisoned,
      operation_in_progress: tabGroupingStrings.applyOperationInProgress,
      unexpected_error: tabGroupingStrings.prepareFailed,
    } satisfies Record<Kind, string>;

    for (const kind of Object.keys(expected) as Kind[]) {
      expect(groupingPrepareFailureMessage({ ok: false, kind, stale: [], errors: [] })).toBe(expected[kind]);
    }
    expect(groupingPrepareFailureMessage({ ok: false, stale: [], errors: ["compile failed"] })).toBe("compile failed");
    expect(groupingPrepareFailureMessage({ ok: false, stale: [], errors: [""] })).toBe(tabGroupingStrings.prepareFailed);
    expect(groupingPrepareFailureMessage({ ok: false, stale: [], errors: [] })).toBe(tabGroupingStrings.prepareFailed);
  });

  it("maps every preview boundary failure kind and the compile fallback", () => {
    type Failure = Parameters<typeof groupingPreviewFailureMessage>[0];
    type BoundaryFailure = Extract<Failure, { kind: string }>;
    type Kind = BoundaryFailure["kind"];
    const expected = {
      schema_incompatible: tabGroupingStrings.applySchemaIncompatible,
      boundary_poisoned: tabGroupingStrings.statusPoisoned,
      operation_in_progress: tabGroupingStrings.applyOperationInProgress,
      unexpected_error: tabGroupingStrings.prepareFailed,
    } satisfies Record<Kind, string>;

    for (const kind of Object.keys(expected) as Kind[]) {
      expect(groupingPreviewFailureMessage({ ok: false, kind, stale: [], errors: [] })).toBe(expected[kind]);
    }
    expect(groupingPreviewFailureMessage({ ok: false, stale: [], errors: ["first", "second"] })).toBe("first / second");
    expect(groupingPreviewFailureMessage({ ok: false, stale: [], errors: [] })).toBe(tabGroupingStrings.prepareFailed);
  });

  it("maps every undo boundary failure kind", () => {
    type Failure = Parameters<typeof groupingUndoFailureMessage>[0];
    type Kind = Failure["kind"];
    const failures = {
      missing: { ok: false, kind: "missing", reason: "" },
      expired: { ok: false, kind: "expired", reason: "期限切れ理由" },
      restore_failed: { ok: false, kind: "restore_failed", reason: "" },
      boundary_poisoned: { ok: false, kind: "boundary_poisoned", reason: "" },
      schema_incompatible: { ok: false, kind: "schema_incompatible", reason: "" },
      operation_in_progress: { ok: false, kind: "operation_in_progress", reason: "" },
      invalid_layout: { ok: false, kind: "invalid_layout", reason: "" },
      unexpected_error: { ok: false, kind: "unexpected_error", reason: "" },
      post_undo_failed: { ok: false, kind: "post_undo_failed", layoutReverted: true, reason: "後処理に失敗しました" },
    } satisfies Record<Kind, Failure>;
    const expected = {
      missing: tabGroupingStrings.undoMissing,
      expired: "期限切れ理由",
      restore_failed: tabGroupingStrings.undoRestoreFailed,
      boundary_poisoned: tabGroupingStrings.statusPoisoned,
      schema_incompatible: tabGroupingStrings.applySchemaIncompatible,
      operation_in_progress: tabGroupingStrings.applyOperationInProgress,
      invalid_layout: tabGroupingStrings.undoRestoreFailed,
      unexpected_error: tabGroupingStrings.undoRestoreFailed,
      post_undo_failed: tabGroupingStrings.undoPostFailed,
    } satisfies Record<Kind, string>;

    for (const kind of Object.keys(failures) as Kind[]) {
      expect(groupingUndoFailureMessage(failures[kind])).toBe(expected[kind]);
    }
    expect(groupingUndoFailureMessage({ ok: false, kind: "expired", reason: "" })).toBe(tabGroupingStrings.undoExpired);
  });
});

describe("TabGroupingPanel three-step state machine", () => {
  it.each([
    ["compare", true, false, false, false, { compare: "current", edit: "todo", confirm: "todo" }],
    ["edit", true, false, false, false, { compare: "done", edit: "current", confirm: "todo" }],
    ["confirm", true, false, false, false, { compare: "done", edit: "done", confirm: "current" }],
    ["compare", false, false, false, false, { compare: "locked", edit: "locked", confirm: "locked" }],
    ["compare", true, true, false, false, { compare: "locked", edit: "locked", confirm: "locked" }],
    ["edit", true, false, true, false, { compare: "locked", edit: "locked", confirm: "locked" }],
    ["confirm", true, false, false, true, { compare: "locked", edit: "locked", confirm: "locked" }],
  ] as const)("derives %s step states", (mode, hasPlans, analyzing, applying, applied, expected) => {
    expect(groupingStepStates({ mode, hasPlans, analyzing, applying, applied })).toEqual(expected);
  });

  it("moves between adjacent steps and stops at both ends", () => {
    expect(nextGroupingStep("compare")).toBe("edit");
    expect(nextGroupingStep("edit")).toBe("confirm");
    expect(nextGroupingStep("confirm")).toBeNull();
    expect(previousGroupingStep("confirm")).toBe("edit");
    expect(previousGroupingStep("edit")).toBe("compare");
    expect(previousGroupingStep("compare")).toBeNull();
  });
});

describe("TabGroupingPanel display ordering", () => {
  const plan = (planId: string, strategy: GroupingPlan["strategy"]): GroupingPlan => ({
    planId,
    title: planId,
    rationale: planId,
    strategy,
    groups: [],
    unassignedTabIds: [],
    warnings: [],
  });

  it("puts project first and preserves source order within one strategy", () => {
    const roleA = plan("role-a", "role");
    const minimal = plan("minimal", "minimal_move");
    const project = plan("project", "project");
    const roleB = plan("role-b", "role");
    expect(orderGroupingPlansForDisplay([roleA, minimal, project, roleB]).map((item) => item.planId)).toEqual([
      "project",
      "role-a",
      "role-b",
      "minimal",
    ]);
  });

  it("keeps context-menu handling as one root-level prevention only", () => {
    const source = readFileSync("src/components/layout/TabGroupingPanel.tsx", "utf8");
    expect(source.match(/onContextMenu/gi) ?? []).toHaveLength(1);
    expect(source).toMatch(/onContextMenu=\{\(event\) => event\.preventDefault\(\)\}/);
    expect(source).not.toMatch(/aria-(?:grabbed|dropeffect)/);
  });
});
