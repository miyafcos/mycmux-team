// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emitTo: vi.fn(async () => {}) }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [] }));
import layout from "../fixtures/livebrief_autonomy/delegation-layout.json";
import invalid from "../fixtures/livebrief_autonomy/delegation-invalid-values.json";
import { toConfig } from "../../src/components/layout/SocketListener";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { persistentLayoutProjection } from "../../src/lib/persistentLayoutProjection";
import type { WorkspaceConfig } from "../../src/lib/ipc";
import type { Workspace } from "../../src/types";

function restore(input: typeof layout): Workspace[] {
  return input.workspaces.map(source => {
    const config = source as unknown as WorkspaceConfig;
    const panes = useWorkspaceLayoutStore.getState().restorePanes(config.id, config.panes, config.split_columns, config.grid_template_id);
    return { id: config.id, name: config.name, gridTemplateId: config.grid_template_id, createdAt: config.created_at, status: "running",
      columnWidths: config.column_widths ?? undefined, ...panes } as Workspace;
  });
}
const mapping = { "shell-starter": "shell-starter" };
const fields = { delegated_by_tab_id: "delegatedByTabId", delegated_by_agent_session_id: "delegatedByAgentSessionId", delegated_at: "delegatedAt" } as const;
describe("H7 full layout delegation compatibility", () => {
  it.each(invalid)("keeps every workspace, pane and sibling while discarding only $name", row => {
    const input = structuredClone(layout);
    const bad = input.workspaces[0].panes[0].tabs[0] as Record<string, unknown>;
    if (row.name === "missing") for (const field of row.remove) delete bad[field];
    Object.assign(bad, row.patch);
    const expected = restore(layout);
    const expectedTab = expected[0].panes[0].tabs[0];
    for (const field of row.remove) expectedTab[fields[field as keyof typeof fields]] = undefined as never;
    const restored = restore(input);
    expect(restored).toEqual(expected);
    expect(restored.flatMap(ws => ws.panes.flatMap(pane => pane.tabs)).map(tab => tab.id)).toEqual(["child", "sibling", "parent", "other"]);
    expect(restored[0].splitColumns).toEqual([["pane-a"], ["pane-b"]]);
    const projection = persistentLayoutProjection(restored);
    expect(projection).toEqual(persistentLayoutProjection(expected));
    const saved = restored.map(ws => toConfig(ws, mapping));
    expect(saved).toEqual(expected.map(ws => toConfig(ws, mapping)));
    expect(restore({ ...input, workspaces: saved } as unknown as typeof layout)).toEqual(restored);
    for (const field of row.remove) expect(saved[0].panes[0].tabs![0][field as keyof typeof fields]).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity, 1.5, 1e30])("tolerates a non-finite or invalid timestamp on restore and on save (%s)", value => {
    const input = structuredClone(layout);
    input.workspaces[0].panes[0].tabs[0].delegated_at = value;
    const restored = restore(input);
    expect(restored[0].panes[0].tabs[0].delegatedAt).toBeUndefined();
    // Also guard corrupted in-memory facts before the actual save projection.
    restored[0].panes[0].tabs[0].delegatedAt = value;
    expect(persistentLayoutProjection(restored).workspaces[0].panes[0].tabs[0].delegatedAt).toBeUndefined();
    expect(toConfig(restored[0], mapping).panes[0].tabs![0].delegated_at).toBeNull();
    expect(restored[1].panes[0].tabs[0].label).toBe("other");
  });
});
