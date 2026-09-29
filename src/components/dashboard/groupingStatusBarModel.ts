import type { GroupingRuntimeState } from "../../stores/groupingRuntimeStore";
import { tabGroupingStrings } from "./dashboardStrings";

export interface GroupingStatusBarOptions {
  appVersion: string;
  layoutRevision: number;
  workspaceCount: number;
  paneCount: number;
  tabCount: number;
}

export type GroupingStatusActionId =
  | "copy_diagnostics"
  | "inspect_layout"
  | "restart_app"
  | "undo"
  | "review_changes"
  | "dismiss";

export interface GroupingStatusAction {
  id: GroupingStatusActionId;
  label: string;
  enabled: boolean;
}

export interface GroupingDiagnosticPayload {
  timestamp: string;
  appVersion: string;
  groupingSchemaVersion: number;
  persistentSchemaVersion: number | null;
  operation: string | null;
  beforeSignature: string | null;
  expectedSignature: string | null;
  actualSignature: string | null;
  layoutRevision: number;
  errors: string[];
  durability: GroupingDiagnosticDurability;
  counts: {
    workspaces: number;
    panes: number;
    tabs: number;
  };
}

export interface GroupingDiagnosticDurability {
  status: GroupingRuntimeState["durability"]["status"];
  layoutRevision: number | null;
  signature: string | null;
  errorCode: "ack_mismatch" | "persistence_failed" | "not_leader" | "leader_unavailable" | null;
}

interface StatusBarViewBase {
  kind: "poisoned" | "undo_available" | "undo_expired" | "durability_warning";
  message: string;
  warning: string | null;
  actions: GroupingStatusAction[];
}

export interface PoisonedStatusBarView extends StatusBarViewBase {
  kind: "poisoned";
  diagnosticPayload: GroupingDiagnosticPayload;
}

export type GroupingStatusBarView =
  | PoisonedStatusBarView
  | (StatusBarViewBase & { kind: "undo_available" | "undo_expired" | "durability_warning" });

const action = (
  id: GroupingStatusActionId,
  label: string,
  enabled = true,
): GroupingStatusAction => ({ id, label, enabled });

function diagnosticDurability(
  durability: GroupingRuntimeState["durability"],
): GroupingDiagnosticDurability {
  if (durability.status === "idle") {
    return { status: "idle", layoutRevision: null, signature: null, errorCode: null };
  }
  return {
    status: durability.status,
    layoutRevision: durability.layoutRevision,
    signature: durability.signature,
    errorCode: durability.status === "deferred"
      ? durability.reason
      : durability.status === "failed" ? durability.errorCode : null,
  };
}

export function selectGroupingStatusBarView(
  runtime: GroupingRuntimeState,
  options: GroupingStatusBarOptions,
): GroupingStatusBarView | null {
  const durabilityWarning = runtime.durability.status === "failed"
    || runtime.durability.status === "deferred"
    ? tabGroupingStrings.statusDurabilityWarning
    : null;

  if (runtime.poisoned) {
    const diagnostic = runtime.diagnostic;
    return {
      kind: "poisoned",
      message: tabGroupingStrings.statusPoisoned,
      warning: durabilityWarning,
      actions: [
        action("copy_diagnostics", tabGroupingStrings.statusCopyDiagnostics),
        action("inspect_layout", tabGroupingStrings.statusInspectLayout),
        action("restart_app", tabGroupingStrings.statusRestartApp),
      ],
      diagnosticPayload: {
        timestamp: new Date(diagnostic?.occurredAt ?? 0).toISOString(),
        appVersion: options.appVersion,
        groupingSchemaVersion: runtime.schemaVersion,
        persistentSchemaVersion: runtime.persistentSchema.loadedSchemaVersion,
        operation: diagnostic?.operation ?? null,
        beforeSignature: diagnostic?.beforeSignature ?? null,
        expectedSignature: diagnostic?.expectedSignature ?? null,
        actualSignature: diagnostic?.actualSignature ?? null,
        layoutRevision: diagnostic?.layoutRevision ?? options.layoutRevision,
        errors: diagnostic?.errors.map((_error, index) => `${diagnostic.code}:${index + 1}`) ?? [],
        durability: diagnosticDurability(runtime.durability),
        counts: {
          workspaces: options.workspaceCount,
          panes: options.paneCount,
          tabs: options.tabCount,
        },
      },
    };
  }

  if (runtime.undo?.status === "available") {
    return {
      kind: "undo_available",
      message: tabGroupingStrings.statusUndoAvailable,
      warning: durabilityWarning,
      actions: [
        action("undo", tabGroupingStrings.statusUndo),
        action("review_changes", tabGroupingStrings.undoReview),
        action("dismiss", tabGroupingStrings.statusDismiss),
      ],
    };
  }

  if (runtime.undo?.status === "expired") {
    return {
      kind: "undo_expired",
      message: runtime.undo.expireReason ?? tabGroupingStrings.undoExpired,
      warning: durabilityWarning,
      actions: [
        action("undo", tabGroupingStrings.statusUndo, false),
        action("dismiss", tabGroupingStrings.statusDismiss),
      ],
    };
  }

  if (durabilityWarning) {
    return {
      kind: "durability_warning",
      message: durabilityWarning,
      warning: null,
      actions: [],
    };
  }

  return null;
}
