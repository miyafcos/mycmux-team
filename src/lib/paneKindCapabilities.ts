import type { PaneTab } from "../types/workspace";

export type PaneKind = NonNullable<PaneTab["type"]>;
export type PaneCloseEffect = "kill" | "hide" | "confirm_unsaved";
export interface PaneKindCapabilities {
  /** Legacy PTY classification; browser/online retain their existing true value. */
  readonly hasPty: boolean;
  readonly persistent: boolean;
  readonly transferable: boolean;
  readonly closeEffect: PaneCloseEffect;
  /** Terminal input only, independently of the legacy hasPty classification. */
  readonly sendable: boolean;
}

/** Kind defaults only. Ephemeral/declared/dirty state is applied separately. */
export const PANE_KIND_CAPABILITIES = {
  terminal: { hasPty: true, persistent: true, transferable: true, closeEffect: "kill", sendable: true },
  browser: { hasPty: true, persistent: false, transferable: true, closeEffect: "confirm_unsaved", sendable: false },
  online: { hasPty: true, persistent: false, transferable: false, closeEffect: "hide", sendable: false },
  web: { hasPty: false, persistent: true, transferable: true, closeEffect: "hide", sendable: false },
  launcher: { hasPty: false, persistent: true, transferable: true, closeEffect: "hide", sendable: false },
} as const satisfies Record<PaneKind, PaneKindCapabilities>;

// Keep old free-form saved values compatible without declaring them supported
// by terminal input or the native single-tab renderer.
const UNKNOWN_CAPABILITIES: PaneKindCapabilities = {
  hasPty: true, persistent: true, transferable: true, closeEffect: "hide", sendable: false,
};
// A malformed saved null still passes the old PTY/detach predicates, but the
// old single-tab close killed only undefined or an explicit terminal type.
const NULL_TYPE_CAPABILITIES: PaneKindCapabilities = {
  ...PANE_KIND_CAPABILITIES.terminal, closeEffect: "hide",
};
export interface PaneCapabilityInput { type?: string | null; ephemeral?: boolean }

export function paneTabKind(tab: PaneCapabilityInput): PaneKind | "unknown" {
  if (tab.type == null) return "terminal";
  return Object.prototype.hasOwnProperty.call(PANE_KIND_CAPABILITIES, tab.type)
    ? tab.type as PaneKind : "unknown";
}

export function paneKindCapabilities(tab: PaneCapabilityInput): PaneKindCapabilities {
  if (tab.type === null) return NULL_TYPE_CAPABILITIES;
  const kind = paneTabKind(tab);
  return kind === "unknown" ? UNKNOWN_CAPABILITIES : PANE_KIND_CAPABILITIES[kind];
}

export function isPersistentTab(tab: PaneCapabilityInput): boolean {
  return !tab.ephemeral && paneKindCapabilities(tab).persistent;
}

export function canTransferTab(tab: PaneCapabilityInput): boolean {
  return !tab.ephemeral && paneKindCapabilities(tab).transferable;
}

export function tabNeedsCloseConfirmation(tab: PaneCapabilityInput & { isDirty?: boolean }): boolean {
  return paneKindCapabilities(tab).closeEffect === "confirm_unsaved" && tab.isDirty === true;
}
