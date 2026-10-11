import { describe, expect, it, vi } from "vitest";
import type { PaneTab, Workspace } from "../../src/types";
import {
  PANE_KIND_CAPABILITIES, paneKindCapabilities, paneTabKind,
  isPersistentTab, canTransferTab, tabNeedsCloseConfirmation,
} from "../../src/lib/paneKindCapabilities";
import { tabHasPty } from "../../src/lib/tabLifecycle";
import { isDetachableTab, isTransferableTab } from "../../src/lib/detachedPane";
import { toConfig } from "../../src/components/layout/SocketListener";

vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: vi.fn(async () => undefined) }));

const kinds = ["terminal", "browser", "online", "web", "launcher"] as const;
const compatibilityTypes = [undefined, null, ...kinds, "future", "__proto__"];

function workspace(type: string | null | undefined, ephemeral = false): Workspace {
  const tab = { id: "t", sessionId: "pty-t", agentId: "shell", type, ephemeral } as PaneTab;
  return { id: "w", name: "Test", gridTemplateId: "1x1", status: "running", createdAt: 0,
    panes: [{ id: "p", agentId: "shell", sessionId: tab.sessionId, tabs: [tab], activeTabId: "t" }] };
}

describe("pane kind capabilities preserve existing defaults", () => {
  it("covers every PaneTab kind with all five capabilities", () => {
    expect(Object.keys(PANE_KIND_CAPABILITIES).sort()).toEqual([...kinds].sort());
    for (const value of Object.values(PANE_KIND_CAPABILITIES)) {
      expect(Object.keys(value).sort()).toEqual(["hasPty", "persistent", "transferable", "closeEffect", "sendable"].sort());
    }
    expect(paneKindCapabilities({})).toBe(PANE_KIND_CAPABILITIES.terminal);
  });

  it.each(compatibilityTypes)("preserves PTY, persistence and transfer predicates for %s", type => {
    const input = { type };
    const legacyPty = type !== "web" && type !== "launcher";
    const legacyPersistence = type !== "browser" && type !== "online";
    const legacyTransfer = type !== "online";
    const legacyDetach = type == null || ["terminal", "launcher", "browser", "web"].includes(type);
    expect(tabHasPty(input)).toBe(legacyPty);
    expect(paneKindCapabilities(input).hasPty).toBe(legacyPty);
    expect(paneKindCapabilities(input).closeEffect === "kill").toBe(type === undefined || type === "terminal");
    expect(isPersistentTab(input)).toBe(legacyPersistence);
    expect(isTransferableTab(input)).toBe(legacyTransfer);
    expect(canTransferTab(input)).toBe(legacyTransfer);
    expect(isDetachableTab(input)).toBe(legacyDetach);
  });

  it.each(compatibilityTypes)("matches actual save and transfer serialization for %s", type => {
    expect(toConfig(workspace(type)).panes.length > 0).toBe(isPersistentTab({ type }));
    expect(toConfig(workspace(type), {}, "transfer").panes.length > 0).toBe(canTransferTab({ type }));
    expect(toConfig(workspace(type, true)).panes).toEqual([]);
    expect(toConfig(workspace(type, true), {}, "transfer").panes).toEqual([]);
  });

  it.each(kinds)("excludes ephemeral %s tabs independently of kind", type => {
    expect(isPersistentTab({ type, ephemeral: true })).toBe(false);
    expect(isTransferableTab({ type, ephemeral: true })).toBe(false);
    expect(isDetachableTab({ type, ephemeral: true })).toBe(false);
  });

  it("preserves the browser/online PTY compatibility discrepancy explicitly", () => {
    for (const type of ["browser", "online"] as const) {
      expect(paneKindCapabilities({ type })).toMatchObject({ hasPty: true, persistent: false, sendable: false });
    }
    expect(paneTabKind({ type: "__proto__" })).toBe("unknown");
  });

  it("requires confirmation only for dirty documents", () => {
    expect(tabNeedsCloseConfirmation({ type: "browser", isDirty: true })).toBe(true);
    expect(tabNeedsCloseConfirmation({ type: "browser" })).toBe(false);
    for (const type of ["terminal", "online", "web", "launcher"] as const) {
      expect(tabNeedsCloseConfirmation({ type, isDirty: true })).toBe(false);
    }
  });
});
