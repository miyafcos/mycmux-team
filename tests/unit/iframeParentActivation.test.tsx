// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusController } from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { closePaneOperation, resetPaneCloseOperationsForTests } from "../../src/lib/paneCloseOperation";
import type { Pane, Workspace } from "../../src/types";

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(),
  readEditableArtifact: vi.fn(async () => ({ content: "<p>Read me</p>", sourceKind: "markdown", sourcePath: "/preview.md" })),
  onSavepointPublishProgress: vi.fn().mockResolvedValue(() => {}), crsmListSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), isTauri: () => false,
  convertFileSrc: (path: string) => `https://asset.localhost${path}`, Channel: class {} }));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: mocks.confirm }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({ usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }) }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: () => <textarea className="xterm-helper-textarea" />, hasTerminalBuffer: () => false }));
import TerminalPane from "../../src/components/workspace/TerminalPane";

let root: Root;
let host: HTMLDivElement;
const terminal: Pane = { id: "terminal", sessionId: "terminal-session", agentId: "shell-starter", activeTabId: "terminal-tab",
  tabs: [{ id: "terminal-tab", sessionId: "terminal-session", agentId: "shell-starter", type: "terminal" }] };
function Harness() {
  const workspace = useWorkspaceListStore(state => state.workspaces[0]);
  return <>{workspace.panes.map(pane => <TerminalPane key={pane.id} pane={pane} workspaceId={workspace.id} />)}</>;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mocks.confirm.mockResolvedValue(true); resetPaneCloseOperationsForTests();
  useSettingsStore.setState({ paneComposerEnabled: false, showTerminalHistoryButton: false, declaredLaunchEnabled: true });
  useDashboardViewStore.setState({ open: false, chatColumnTabIds: [], pinnedChatColumnTabIds: [] });
  useSessionAttentionStore.getState().resetForTests();
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  focusController.request("tab-rename", { suppressMs: 0 });
  useUiStore.setState({ activePaneId: "terminal-session", lastActivePaneId: "terminal-session", focusRevision: 0, zoomedPaneId: null });
  const preview: Pane = { id: "preview", sessionId: "preview-session", agentId: "shell-starter", activeTabId: "preview-tab",
    tabs: [{ id: "preview-tab", sessionId: "preview-session", agentId: "shell-starter", type: "browser", sourceKind: "markdown",
      htmlPath: "/preview.html", sourcePath: "/preview.md" }] };
  const workspace: Workspace = { id: "workspace", name: "Synthetic", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [terminal, preview] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  resetPaneCloseOperationsForTests(); focusController.clearSession("terminal-session");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function mount(): Promise<HTMLIFrameElement> {
  await act(async () => root.render(<Harness />));
  const frame = host.querySelector("iframe")!;
  expect(frame).not.toBeNull(); return frame;
}

describe("parent document iframe focus activation", () => {
  it("activates the real PDF embed and advances revision on a valid reselection without moving focus", async () => {
    useWorkspaceListStore.setState(current => ({ workspaces: current.workspaces.map(workspace => ({ ...workspace,
      panes: workspace.panes.map(pane => pane.id !== "preview" ? pane : { ...pane, tabs: pane.tabs.map(tab => ({ ...tab,
        sourceKind: "pdf" as const, htmlPath: "/preview.pdf", sourcePath: "/preview.pdf",
      })) }),
    })) }));
    await act(async () => root.render(<Harness />));
    const embed = host.querySelector<HTMLEmbedElement>("embed[type='application/pdf']")!;
    expect(embed).not.toBeNull();
    // jsdom has no native PDF plugin to make the embed focusable.
    embed.tabIndex = 0; const focus = vi.spyOn(focusController, "request");
    await act(async () => embed.focus());
    expect(useUiStore.getState().activePaneId).toBe("preview-session"); expect(document.activeElement).toBe(embed);
    const revision = useUiStore.getState().focusRevision;
    await act(async () => { host.querySelector<HTMLTextAreaElement>("[data-dnd-pane-id='terminal'] textarea")!.focus(); embed.focus(); });
    expect(useUiStore.getState().focusRevision).toBeGreaterThan(revision); expect(document.activeElement).toBe(embed);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["document", "focusin", "blur"].flatMap(path => ["declared", "receipt"].map(kind => [path, kind])))
    ("cancels an older heading through iframe %s reselection before %s activation", async (path, kind) => {
      const delayed: Pane = { id: "delayed", agentId: "shell-starter", sessionId: "delayed-session", activeTabId: "delayed-tab",
        tabs: [{ id: "delayed-tab", sessionId: "delayed-session", agentId: "shell-starter", type: "terminal", agentKind: "codex",
          ...(kind === "declared" ? { lifecycle: "declared" as const } : { agentSessionId: "synthetic-resume" }) }] };
      await act(async () => useWorkspaceListStore.setState(current => ({ workspaces: current.workspaces.map(workspace => ({ ...workspace,
        panes: [...workspace.panes.filter(pane => pane.id !== "delayed"), delayed],
      })) })));
      if (kind === "receipt") useSessionAttentionStore.setState({ dormantCompletionsBySession: { "delayed-session": {
        tabIds: ["delayed-tab"], receipt: { ptySessionId: "delayed-session", agentKind: "codex", agentSessionId: "synthetic-resume",
          ptyGeneration: 1, savedAt: 1, bytes: 100 }, attention: { sessionId: "delayed-session", sessionEpoch: 1,
          attentionId: "done", kind: "done", detail: null, sessionRevision: 1, uiState: "done", stateSince: 1, occurrenceOrder: 1 },
      } } });
      const frame = await mount();
      const source = frame.srcdoc; frame.removeAttribute("srcdoc"); frame.src = "about:blank";
      const doc = frame.contentDocument!; doc.open(); doc.write(source); doc.close();
      await act(async () => frame.dispatchEvent(new Event("load")));
      const launch = vi.spyOn(useWorkspaceLayoutStore.getState(), "launchDeclaredTab").mockImplementation(() => {});
      await act(async () => useUiStore.getState().setActivePaneId("preview-session"));
      const heading = host.querySelector<HTMLElement>("[data-dnd-pane-id='delayed'] .pane-active-heading")!;
      await act(async () => { heading.focus(); heading.click(); await vi.advanceTimersByTimeAsync(50); });
      const revision = useUiStore.getState().focusRevision;
      await act(async () => {
        if (path === "document") {
          for (const phase of ["down", "up"]) {
            const event = new MouseEvent(`pointer${phase}`, { bubbles: true, button: 0, clientX: 20, clientY: 30 });
            Object.defineProperty(event, "pointerId", { value: 7 }); doc.querySelector("p")!.dispatchEvent(event);
          }
        } else if (path === "focusin") frame.focus();
        else {
          vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
          vi.spyOn(document, "hasFocus").mockReturnValue(true);
          window.dispatchEvent(new Event("blur")); await vi.advanceTimersByTimeAsync(0);
        }
      });
      const reselectionRevision = useUiStore.getState().focusRevision;
      await act(async () => vi.advanceTimersByTimeAsync(600));
      expect(useUiStore.getState().activePaneId).toBe("preview-session"); expect(launch).not.toHaveBeenCalled();
      expect(useDashboardViewStore.getState().open).toBe(false);
      expect(reselectionRevision).toBeGreaterThan(revision);
      vi.restoreAllMocks(); useDashboardViewStore.setState({ open: false });
  });

  it("ignores an other-application blur even when activeElement is the retained iframe", async () => {
    const frame = await mount(); frame.focus();
    useUiStore.getState().setActivePaneId("terminal-session");
    const before = useUiStore.getState(); vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("blur")); await vi.advanceTimersByTimeAsync(0); });
    expect(useUiStore.getState().activePaneId).toBe(before.activePaneId);
    expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  });

  it("discards an older iframe blur after a newer terminal selection", async () => {
    const frame = await mount(); frame.focus(); vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("blur")); useUiStore.getState().setActivePaneId("terminal-session");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useUiStore.getState().activePaneId).toBe("terminal-session");
  });

  it.each(["focusin", "blur"])("activates the actual iframe through %s without changing DOM focus", async path => {
    const frame = await mount();
    const focus = vi.spyOn(focusController, "request");
    await act(async () => {
      frame.focus();
      if (path === "blur") {
        useUiStore.getState().setActivePaneId("terminal-session");
        window.dispatchEvent(new Event("blur"));
      }
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.activeElement).toBe(frame);
    expect(useUiStore.getState().activePaneId).toBe("preview-session");
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["background", "hidden", "closing", "zoom"])("rejects parent focus activation for a %s source", async state => {
    const frame = await mount();
    let release: ((result: boolean) => void) | undefined;
    let closing: ReturnType<typeof closePaneOperation> | undefined;
    await act(async () => {
      if (state === "background") useWorkspaceListStore.setState({ activeWorkspaceId: "other" });
      if (state === "zoom") useUiStore.getState().setZoomedPaneId("terminal");
      if (state === "hidden") useWorkspaceListStore.setState(current => ({ workspaces: current.workspaces.map(workspace => ({ ...workspace,
        panes: workspace.panes.map(pane => pane.id !== "preview" ? pane : { ...pane, activeTabId: "sibling",
          tabs: [...pane.tabs, { ...pane.tabs[0], id: "sibling", sessionId: "sibling-session", type: "terminal" as const }] }),
      })) }));
      if (state === "closing") {
        mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { release = resolve; }));
        closing = closePaneOperation({ kind: "pane", workspaceId: "workspace", paneId: "preview" }, "ui");
      }
      // Exercise a queued focusin before React removes a newly hidden frame.
      frame.focus();
      expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    });
    try {
      await act(async () => { frame.focus(); window.dispatchEvent(new Event("blur")); await vi.advanceTimersByTimeAsync(0); });
      expect(useUiStore.getState().activePaneId).toBe("terminal-session");
    } finally { release?.(false); await closing; }
  });

  it("ignores terminal root and xterm input focus, preserving the terminal focus controller", async () => {
    await mount();
    useUiStore.getState().setActivePaneId("unrelated-session");
    const focus = vi.spyOn(focusController, "request");
    const pane = host.querySelector<HTMLElement>("[data-dnd-pane-id='terminal']")!;
    const input = pane.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      pane.focus(); input.focus(); window.dispatchEvent(new Event("blur")); await vi.advanceTimersByTimeAsync(0);
    });
    expect(useUiStore.getState().activePaneId).toBe("unrelated-session"); expect(document.activeElement).toBe(input);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => {
      focusController.request("pointer", { sessionId: "terminal-session", action: "commit" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useUiStore.getState().activePaneId).toBe("terminal-session"); expect(document.activeElement).toBe(input);
  });
});
