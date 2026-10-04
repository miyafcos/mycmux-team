import { beforeEach, describe, expect, it, vi } from "vitest";
import { partitionSavedWindows, type SavedWindowWorkspace } from "../../src/lib/detachedPane";
import { reopenSavedWindows, toConfig } from "../../src/components/layout/SocketListener";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

const ipc = vi.hoisted(() => ({ openWorkspaceWindow: vi.fn() }));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(), openWorkspaceWindow: ipc.openWorkspaceWindow,
}));

function config(id: string, label?: string, detached = false): SavedWindowWorkspace {
  return {
    id, name: id, created_at: 1, grid_template_id: "1x1", detached,
    panes: [{ pane_id: id + "-pane", agent_id: "shell-starter", label: null,
      active_tab_id: id + "-tab", tabs: [{ tab_id: id + "-tab", session_id: "pty-" + id, agent_id: "shell-starter", type: "terminal", label: id }] }],
    split_columns: [[0]], column_widths: [1], row_heights_per_col: [[1]],
    window_group: label ? { label, frame: { x: 240, y: 180, width: 840, height: 620 }, active_workspace_id: id,
      active_pane_id: id + "-pane", active_tab_id: id + "-tab" } : undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  ipc.openWorkspaceWindow.mockResolvedValue("mycmux-w1");
});

describe("saved window ownership and schema-1 upgrade", () => {
  it("keeps legacy ordinary workspaces in main and legacy detached panes separate", () => {
    const data = [config("ordinary"), config("legacy-pane", undefined, true)];
    const result = partitionSavedWindows(data);
    expect(result.main.map((item) => item.id)).toEqual(["ordinary"]);
    expect(result.windows).toEqual([{ configs: [data[1]], frame: undefined }]);
    expect(JSON.parse(JSON.stringify(data))).toEqual(JSON.parse(JSON.stringify([config("ordinary"), config("legacy-pane", undefined, true)])));
  });

  it("groups multiple workspaces and both detached and normal shells by owner", () => {
    const data = [config("main", "main"), config("a", "mycmux-w2"), config("b", "mycmux-w2"), config("pane", "mycmux-w1", true)];
    const frozen = JSON.stringify(data);
    const result = partitionSavedWindows(data);
    expect(result.main.map((item) => item.id)).toEqual(["main"]);
    expect(result.windows.map((group) => group.configs.map((item) => item.id))).toEqual([["a", "b"], ["pane"]]);
    for (let count = 0; count < 6; count++) expect(partitionSavedWindows(JSON.parse(frozen))).toEqual(result);
    expect(JSON.stringify(data)).toBe(frozen);
  });

  it("reserves recorded labels first, drops duplicate identities, and rejects unsafe labels", () => {
    const result = partitionSavedWindows([config("legacy", undefined, true), config("a", "mycmux-w2"), config("a", "mycmux-w3"),
      config("invalid", "mycmux-w01"), config("overflow", "mycmux-w4294967296")]);
    expect(result.windows.map((group) => group.label)).toEqual(["mycmux-w2", undefined]);
    expect(result.main.map((item) => item.id)).toEqual(["invalid", "overflow"]);
  });

  it("reopens each complete group once at its inner frame instead of one window per workspace", async () => {
    const a = config("a", "mycmux-w2"), b = config("b", "mycmux-w2");
    a.window_frame = { x: 240, y: 180, width: 840, height: 648 };
    await reopenSavedWindows(partitionSavedWindows([a, b]).windows);
    expect(ipc.openWorkspaceWindow).toHaveBeenCalledExactlyOnceWith({ fromLabel: "main", label: "mycmux-w2", workspaces: [a, b],
      x: 240, y: 180, width: 840, height: 620 });
  });

  it("falls back without losing a failed group's layouts or retaining detached marks", async () => {
    ipc.openWorkspaceWindow.mockRejectedValue(new Error("cannot build window"));
    await reopenSavedWindows(partitionSavedWindows([config("a", "mycmux-w2"), config("b", "mycmux-w2")]).windows);
    const stored = useWorkspaceListStore.getState().workspaces;
    expect(stored.map((item) => item.id)).toEqual(["a", "b"]);
    expect(stored.map((item) => item.panes[0].tabs[0].id)).toEqual(["a-tab", "b-tab"]);
    expect(stored.map((item) => toConfig(item).detached)).toEqual([undefined, undefined]);
  });

  it("uses real restoration and serialization to preserve layout, selection and divider pins", () => {
    const saved = config("layout", "mycmux-w3");
    saved.panes.push({ ...saved.panes[0], pane_id: "second-pane", active_tab_id: "second-tab",
      tabs: [{ ...saved.panes[0].tabs![0], tab_id: "second-tab", session_id: "pty-second" }] });
    saved.split_columns = [[0], [1]]; saved.column_widths = [.35, .65]; saved.row_heights_per_col = [[1], [1]];
    saved.column_divider_pins = [true]; saved.row_divider_pins_per_col = [[], []];
    const result = restoreWorkspaceConfigs([saved], { activeWorkspaceId: saved.id, activePaneId: "second-pane", activeTabId: "second-tab" });
    expect(result.activePaneSessionId).toBe("pty-second");
    const serialized = toConfig(useWorkspaceListStore.getState().getWorkspace(saved.id)!);
    expect(serialized).toMatchObject({ id: saved.id, split_columns: [[0], [1]], column_widths: [.35, .65],
      column_divider_pins: [true], row_divider_pins_per_col: [[], []] });
  });
});

it("retains small native window frames and replaces non-finite saved coordinates", async () => {
  const saved = config("small-native", "mycmux-w1");
  saved.window_group!.decorated = false;
  saved.window_group!.frame = { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 300, height: 200 };
  await reopenSavedWindows(partitionSavedWindows([saved]).windows);
  expect(ipc.openWorkspaceWindow).toHaveBeenCalledExactlyOnceWith({ fromLabel: "main", label: "mycmux-w1", workspaces: [saved],
    x: 120, y: 120, width: 300, height: 200 });
});

it("keeps ordinary undecorated windows distinct from smaller native windows", async () => {
  const saved = config("ordinary", "mycmux-w1");
  saved.window_group!.decorated = false;
  saved.window_group!.native_tearout = false;
  saved.window_group!.frame = { x: 250, y: 180, width: 300, height: 200 };
  await reopenSavedWindows(partitionSavedWindows([saved]).windows);
  expect(ipc.openWorkspaceWindow).toHaveBeenCalledExactlyOnceWith({ fromLabel: "main", label: "mycmux-w1", workspaces: [saved],
    x: 250, y: 180, width: 600, height: 400 });
});
