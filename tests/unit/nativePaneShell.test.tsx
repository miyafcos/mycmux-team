// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "../../src/types";

const mocks = vi.hoisted(() => ({
  panes: [] as Pane[],
  fragments: vi.fn<() => Promise<Array<{ window_label: string }>>>(),
  confirm: vi.fn(async (_body: string, _options: Record<string, unknown>) => true),
  close: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging: vi.fn() }) }));
vi.mock("../../src/lib/appConfirmation", () => ({ cancelAppConfirmations: vi.fn(() => false), confirm: mocks.confirm }));
vi.mock("../../src/lib/ipc", () => ({ getWindowFragments: mocks.fragments }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "mycmux-native" }));
vi.mock("../../src/stores/paneMetadataStore", () => ({
  usePaneMetadataStore: { getState: () => ({ metadata: {}, volatileMetadata: {} }) },
}));
vi.mock("../../src/stores/workspaceListStore", () => ({
  useWorkspaceListStore: (select: (state: unknown) => unknown) => select({ workspaces: [{ panes: mocks.panes }] }),
}));
vi.mock("../../src/stores/themeStore", () => ({ useThemeStore: () => ({ themeTweaks: { background: "#000" } }) }));
vi.mock("../../src/components/layout/themeVars", () => ({ buildThemeVars: () => ({}) }));
vi.mock("../../src/components/workspace/WorkspaceView", () => ({ default: () => null }));
vi.mock("../../src/components/workspace/PaneDragOverlay", () => ({ default: () => null }));
vi.mock("../../src/components/layout/SocketListener", () => ({ closeWindowWorkspacesAndDestroy: mocks.close }));
vi.mock("../../src/lib/tearout/runtime", () => ({ useTearoutStore: vi.fn(), regrabTearoutWindow: vi.fn() }));

const { default: NativePaneShell } = await import("../../src/components/layout/NativePaneShell");
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.fragments.mockResolvedValue([{ window_label: "main" }, { window_label: "mycmux-native" }]);
  mocks.panes = [{ id: "pane", agentId: "shell", activeTabId: "a", tabs: [
    { id: "a", agentId: "shell", sessionId: "session-a" },
    { id: "b", agentId: "shell", sessionId: "session-b" },
  ] }];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<NativePaneShell />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function close() {
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
}

describe("native pane window close confirmation", () => {
  it("asks to close this window when other windows remain, excluding itself and duplicate fragments", async () => {
    mocks.fragments.mockResolvedValue([
      { window_label: "main" }, { window_label: "main" },
      { window_label: "mycmux-peer" }, { window_label: "mycmux-native" }, { window_label: "" },
    ]);
    await close();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    const [body, options] = mocks.confirm.mock.calls[0];
    expect(options.title).toBe("このウィンドウを閉じます");
    expect(body).toContain("他の 2 個のウィンドウ");
    expect(body).not.toContain("次に起動したときに、いまの状態から再開できます。");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("uses the last-window wording only when no peer window remains", async () => {
    mocks.fragments.mockResolvedValue([{ window_label: "mycmux-native" }]);
    await close();
    expect(mocks.confirm.mock.calls[0][1].title).toBe("mycmux を終了します");
  });
  it("does not close the window when the confirmation is canceled", async () => {
    mocks.confirm.mockResolvedValue(false);
    await close();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  });
  it("does not mislabel an unknown peer count as quitting the app", async () => {
    mocks.fragments.mockRejectedValue(new Error("registry unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await close();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    warning.mockRestore();
  });
  it("keeps the existing one-pane close behavior without querying other windows", async () => {
    mocks.panes[0].tabs = [mocks.panes[0].tabs![0]];
    await act(async () => root.render(<NativePaneShell />));
    await close();
    expect(mocks.fragments).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
