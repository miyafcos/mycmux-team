import { Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import type { WindowFragment, WindowTabIndex } from "../../../src/lib/ipc";

const ipc = vi.hoisted(() => ({
  child: "mycmux-w2",
  detached: "mycmux-w1",
  current: "mycmux-w2",
  shellReady: Promise.resolve(),
  listenerReady: Promise.resolve(),
  firstListenReply: undefined as Promise<void> | undefined,
  receivers: new Set<(event: { payload: unknown }) => void>(),
  startingShell: vi.fn(),
  published: [] as WindowFragment[],
  readiness: [] as boolean[],
  advertised: undefined as WindowTabIndex["account_management_subscription"],
  readinessSequence: 0,
  document: 0,
  readDocument: vi.fn(async () => 0),
  closing: false,
  quitting: false,
  killSession: vi.fn(async () => {}),
  publicationId: undefined as string | undefined,
  receive: undefined as ((event: { payload: unknown }) => void) | undefined,
  focus: vi.fn(async (_label?: string) => {}),
  publishReadiness: vi.fn(async (_ready: boolean) => {}),
  startListener: vi.fn(async () => {}),
  metadata: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  close: undefined as ((event: { preventDefault: () => void }) => Promise<void>) | undefined,
  confirm: vi.fn(async () => true),
  hide: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  isMac: false,
  events: new Map<string, (event: { payload: unknown }) => void>(),
  result: new Map<string, (event: { payload: unknown }) => void>(),
  beforeDelivery: vi.fn(async () => {}),
  beforeResult: vi.fn(async () => {}),
  breakSettings: false,
  settingsPending: undefined as Promise<void> | undefined,
  breakTitleBar: false,
}));

export { ipc };

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  isTauri: () => false,
  convertFileSrc: (file: string) => file,
  invoke: vi.fn(async (name: string, args?: {
    fragment?: WindowFragment; accountManagementReady?: boolean; label?: string;
    publicationId?: string; accountManagementSubscriptionId?: string;
    readAccountManagementDocument?: boolean; accountManagementSequence?: number; includeQuitState?: boolean;
    accountManagementDocument?: number;
    accountManagementSubscription?: WindowTabIndex["account_management_subscription"];
    closing?: boolean;
  }) => {
    switch (name) {
      case "load_persistent_data":
        return { supported: true, schemaVersion: 1, data: { schema_version: 1, workspaces: [],
          settings: { theme_id: "default", font_size: 14, line_height: 1.2, font_family: "monospace" },
        } };
      case "get_app_settings":
        return { schema_version: 1, theme_id: "default", font_size: 14, line_height: 1.2, font_family: "monospace" };
      case "get_default_shell":
        return { command: "/bin/bash", args: [] };
      case "get_terminal_config":
        return {};
      case "launcher_dirs_get":
        return { doc: { sections: [], entries: [] }, entries_exist: [] };
      case "list_cli_accounts":
        return { profiles: [], live: [], active: { claude: null, codex: null, grok: null }, orphans: [] };
      case "get_wallpaper_cache_state":
        return { entries: [] };
      case "publish_window_fragment":
        if (args?.fragment && !ipc.closing) ipc.published.push(args.fragment);
        if (args?.readAccountManagementDocument) return ipc.readDocument();
        if (typeof args?.accountManagementReady === "boolean") {
          const sequence = args.accountManagementSequence!;
          await ipc.publishReadiness(args.accountManagementReady);
          if (args.accountManagementDocument !== ipc.document) throw "window publisher has been replaced or destroyed";
          if (ipc.publicationId !== args.publicationId) {
            ipc.publicationId = args.publicationId;
            ipc.readinessSequence = 0;
          }
          if (sequence > ipc.readinessSequence) {
            ipc.readinessSequence = sequence;
            ipc.readiness.push(args.accountManagementReady);
            ipc.advertised = args.accountManagementReady ? {
              publication_id: args.publicationId ?? "",
              subscription_id: args.accountManagementSubscriptionId!,
            } : undefined;
          }
        }
        return null;
      case "get_window_fragments":
        return ipc.published.slice(-1).filter(fragment => !args?.label || fragment.window_label === args.label);
      case "get_window_tab_index": {
        const entry = {
          window_label: ipc.child, pending: false, workspaces: [],
          account_management_ready: !ipc.closing && (ipc.readiness.at(-1) ?? false),
          account_management_subscription: ipc.closing ? undefined : ipc.advertised,
        };
        const windows = [entry] satisfies WindowTabIndex[];
        return args?.includeQuitState && ipc.quitting ? { windows, quitting: true } : windows;
      }
      case "focus_window": {
        const expected = args?.accountManagementSubscription;
        if (expected && (expected.publication_id !== ipc.advertised?.publication_id
          || expected.subscription_id !== ipc.advertised?.subscription_id)) throw "window_generation_mismatch";
        await ipc.focus(args?.label);
        return null;
      }
      case "set_window_close_intent": {
        ipc.closing = args!.closing!;
        return null;
      }
      case "kill_session":
        await ipc.killSession();
        return null;
      case "get_session_status_snapshot":
        return { sessions: [], occurrence_order: 0 };
      case "claim_layout_leader":
        return ipc.current === "main";
      case "get_launch_cwd":
        return null;
      case "get_pty_metadata_snapshot":
        return ipc.metadata();
      case "read_agent_session_mappings":
        return {};
      default:
        return [];
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, receive: (event: { payload: unknown }) => void,
    options?: { target: { label: string } }) => {
    if (name === "mycmux://account-management-result" && options) {
      const label = options.target.label;
      ipc.result.set(label, receive);
      return () => { ipc.result.delete(label); };
    }
    if (name !== "mycmux://open-dashboard") {
      ipc.events.set(name, receive);
      return () => { if (ipc.events.get(name) === receive) ipc.events.delete(name); };
    }
    const heldReply = ipc.firstListenReply;
    ipc.firstListenReply = undefined;
    await ipc.startListener();
    await ipc.listenerReady;
    ipc.receivers.add(receive);
    ipc.receive = receive;
    await heldReply;
    return () => {
      ipc.receivers.delete(receive);
      if (ipc.receive === receive) ipc.receive = undefined;
    };
  }),
  emitTo: vi.fn(async (to: string | { label: string }, name: string, payload: unknown) => {
    const label = typeof to === "string" ? to : to.label;
    if (name === "mycmux://open-dashboard" && label === ipc.child) {
      await ipc.beforeDelivery();
      for (const receive of ipc.receivers) receive({ payload });
    } else if (name === "mycmux://account-management-result") {
      await ipc.beforeResult();
      ipc.result.get(label)?.({ payload });
    }
  }),
}));
vi.mock("@tauri-apps/api/window", async original => ({
  ...await original<object>(),
  getAllWindows: async () => [...new Set([ipc.child, ipc.detached, ipc.current])].map(label => ({ label })),
  getCurrentWindow: () => ({
    label: ipc.current,
    outerPosition: async () => ({ x: 0, y: 0 }),
    scaleFactor: async () => 1,
    onCloseRequested: async (handler: typeof ipc.close) => {
      ipc.close = handler;
      return () => { if (ipc.close === handler) ipc.close = undefined; };
    },
    hide: ipc.hide,
    destroy: ipc.destroy,
    setTitle: async () => {},
    listen: async () => () => {},
    show: async () => {},
    setFocus: async () => {},
  }),
}));
vi.mock("@tauri-apps/api/webview", async original => ({
  ...await original<object>(),
  getCurrentWebview: () => ({
    label: ipc.child,
    listen: async () => () => {},
    onDragDropEvent: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/fixture/home" }));
vi.mock("../../../src/lib/windowContext", async original => ({
  ...await original<object>(),
  windowLabel: () => ipc.current,
  isMainWindow: () => ipc.current === "main",
}));
vi.mock("../../../src/components/layout/AppShell", async original => {
  ipc.startingShell();
  await ipc.shellReady;
  return original<object>();
});
vi.mock("../../../src/lib/keybindings", async original => ({
  ...await original<object>(),
  get IS_MAC() { return ipc.isMac; },
}));
vi.mock("../../../src/lib/paneCloseConfirmation", async original => ({
  ...await original<object>(),
  confirmPaneClose: ipc.confirm,
}));
vi.mock("../../../src/components/dashboard/DashboardButton", async original => {
  const actual = await original<typeof import("../../../src/components/dashboard/DashboardButton")>();
  return { DashboardButton: () => {
    if (ipc.breakTitleBar) throw new Error("fixture TitleBar failed");
    return <actual.DashboardButton />;
  } };
});
vi.mock("../../../src/components/settings/SettingsDialog", async original => {
  const actual = await original<typeof import("../../../src/components/settings/SettingsDialog")>();
  type Props = Parameters<typeof actual.default>[0];
  function DeferredSettings(props: Props) {
    if (ipc.settingsPending) throw ipc.settingsPending;
    return <actual.default {...props} />;
  }
  return { ...actual, default: (props: Props) => {
    if (ipc.breakSettings) throw new Error("fixture settings render failed");
    return ipc.settingsPending
      ? <Suspense fallback={null}><DeferredSettings {...props} /></Suspense>
      : <actual.default {...props} />;
  } };
});
vi.mock("../../../src/components/terminal/XTermWrapper", async original => ({
  ...await original<object>(), default: () => null,
}));
vi.mock("../../../src/components/layout/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../../../src/components/dashboard/DashboardView", () => ({ DashboardView: () => null }));
vi.mock("allotment", () => {
  const Frame = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Allotment: Object.assign(Frame, { Pane: Frame }) };
});

import { useWorkspaceListStore } from "../../../src/stores/workspaceListStore";
import { useUiStore } from "../../../src/stores/uiStore";
import { __resetWindowCloseStateForTests } from "../../../src/components/layout/SocketListener";
import { __resetPersistenceCoordinatorForTests } from "../../../src/lib/workspacePersistenceCoordinator";
import { setAppShellClosing } from "../../../src/lib/mainDashboardRequests";

beforeEach(() => {
  vi.clearAllMocks();
  ipc.child = ipc.current = "mycmux-w2";
  ipc.shellReady = ipc.listenerReady = Promise.resolve();
  ipc.receive = ipc.close = ipc.firstListenReply = undefined;
  ipc.receivers.clear();
  ipc.published.length = ipc.readiness.length = 0;
  ipc.advertised = ipc.publicationId = undefined;
  ipc.readinessSequence = ipc.document = 0;
  ipc.closing = ipc.quitting = false;
  ipc.readDocument.mockReset().mockImplementation(async () => ipc.document);
  ipc.killSession.mockReset().mockResolvedValue(undefined);
  ipc.events.clear();
  ipc.result.clear();
  ipc.isMac = ipc.breakTitleBar = ipc.breakSettings = false;
  ipc.settingsPending = undefined;
  ipc.beforeResult.mockReset().mockResolvedValue(undefined);
  ipc.publishReadiness.mockReset().mockResolvedValue(undefined);
  ipc.startListener.mockReset().mockResolvedValue(undefined);
  ipc.beforeDelivery.mockReset().mockResolvedValue(undefined);
  ipc.focus.mockReset().mockResolvedValue(undefined);
  ipc.destroy.mockReset().mockResolvedValue(undefined);
  ipc.metadata.mockReset().mockResolvedValue({});
  ipc.confirm.mockReset().mockResolvedValue(true);
  __resetWindowCloseStateForTests();
  setAppShellClosing(false);
  __resetPersistenceCoordinatorForTests();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  useUiStore.getState().clearRequestedSettingsTab();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
