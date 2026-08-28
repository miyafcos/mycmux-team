import {
  captureGroupingSchemaStamp,
  GroupingUnavailableError,
  useGroupingRuntimeStore,
} from "../../stores/groupingRuntimeStore";
import type { GroupingPlan } from "./tabGrouping";
import { compileGroupingPlan } from "./tabGroupingEngine";
import {
  commitGroupingAtStoreBoundary,
  getGroupingStoreAdapter,
  prepareGroupingAtStoreBoundary,
  undoGroupingAtStoreBoundary,
} from "./groupingStoreAdapter";

type GroupingPreviewCompileResult = ReturnType<typeof compileGroupingPlan>;
type GroupingPreviewContext = Parameters<typeof prepareGroupingAtStoreBoundary>[1];
type StoreBoundaryPreviewFailure = {
  ok: false;
  kind: "boundary_poisoned" | "operation_in_progress" | "schema_incompatible" | "unexpected_error";
  stale: [];
  errors: string[];
};

export type GroupingBoundaryPreviewResult = GroupingPreviewCompileResult | StoreBoundaryPreviewFailure;

function previewGroupingAtBoundary(
  plan: GroupingPlan,
  context: GroupingPreviewContext,
): GroupingBoundaryPreviewResult {
  try {
    // Mirrors assertGroupingPreviewAvailable in groupingStoreAdapter.ts:66-74.
    const runtime = useGroupingRuntimeStore.getState();
    if (runtime.poisoned) {
      throw new Error("grouping boundary is poisoned");
    }
    if (runtime.operation !== null || runtime.transitionDepth > 0) {
      throw new Error("grouping boundary operation is in progress");
    }
    captureGroupingSchemaStamp();
    const adapter = getGroupingStoreAdapter();
    const selection = adapter.getSelection();
    return compileGroupingPlan(plan, adapter.getWorkspaces(), {
      ...structuredClone(context),
      activeWorkspaceId: selection.activeWorkspaceId,
      activeSessionId: selection.activeSessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const runtime = useGroupingRuntimeStore.getState();
    if (runtime.poisoned) {
      return { ok: false, kind: "boundary_poisoned", stale: [], errors: [message] };
    }
    if (runtime.operation !== null || runtime.transitionDepth > 0) {
      return { ok: false, kind: "operation_in_progress", stale: [], errors: [message] };
    }
    if (error instanceof GroupingUnavailableError) {
      return { ok: false, kind: "schema_incompatible", stale: [], errors: [message] };
    }
    return { ok: false, kind: "unexpected_error", stale: [], errors: [message] };
  }
}

/** The sole production entrypoint for Gate 2 grouping operations. */
export const groupingBoundary = Object.freeze({
  prepare: prepareGroupingAtStoreBoundary,
  commit: commitGroupingAtStoreBoundary,
  undo: undoGroupingAtStoreBoundary,
  preview: previewGroupingAtBoundary,
});
