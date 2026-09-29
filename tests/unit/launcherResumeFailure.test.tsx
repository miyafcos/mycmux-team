// @vitest-environment jsdom
//
// "続きから" used to swallow the reason it came back empty, so a history that
// could not be read looked exactly like a history with nothing in it — which is
// how the macOS builds hid a missing session index for weeks.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const settings = {
    launcherHiddenIds: [] as string[],
    crsmShowClaude: true,
    crsmShowCodex: true,
    crsmShowClaudeCodex: true,
    hideSessionsWithoutUserMessages: true,
  };
  const dirs = { view: null, load: async () => {} };
  const layout = {
    addTabToPaneWithOptions: () => {},
    addWebTabToPane: () => {},
    removeTabFromPane: () => {},
  };
  const ui = { setActivePaneId: () => {}, requestSettingsTab: () => {} };
  return {
    crsmListSessions: vi.fn(),
    launcherRecordDirMru: vi.fn(async () => {}),
    settings,
    dirs,
    layout,
    ui,
  };
});

vi.mock("../../src/lib/ipc", () => ({
  crsmListSessions: mocks.crsmListSessions,
  launcherRecordDirMru: mocks.launcherRecordDirMru,
}));
vi.mock("../../src/stores/settingsStore", () => ({
  useSettingsStore: (select: (state: typeof mocks.settings) => unknown) => select(mocks.settings),
}));
vi.mock("../../src/stores/launcherDirsStore", () => ({
  useLauncherDirsStore: (select: (state: typeof mocks.dirs) => unknown) => select(mocks.dirs),
}));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({
  useWorkspaceLayoutStore: (select: (state: typeof mocks.layout) => unknown) => select(mocks.layout),
}));
vi.mock("../../src/stores/uiStore", () => ({
  useUiStore: Object.assign(
    (select: (state: typeof mocks.ui) => unknown) => select(mocks.ui),
    { getState: () => mocks.ui },
  ),
}));

import LauncherPane from "../../src/components/workspace/LauncherPane";
import { launcherStrings as S } from "../../src/components/workspace/launcherStrings";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, so the pane's keyboard cursor cannot scroll to itself.
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement | null = null;

async function mountLauncher(): Promise<string> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <LauncherPane
        workspaceId="ws"
        paneId="pane"
        tabId="tab"
        sessionId="session"
        isActive={false}
      />,
    );
  });
  // Let the session fetch settle before reading the pane.
  await act(async () => { await Promise.resolve(); });
  return host.textContent ?? "";
}

beforeEach(() => {
  mocks.crsmListSessions.mockReset();
});

afterEach(() => {
  host?.remove();
  host = null;
});

describe("launcher 続きから failure state", () => {
  it("names the failure and its reason when the session list cannot be read", async () => {
    mocks.crsmListSessions.mockRejectedValue(new Error("failed to resolve home directory"));
    const text = await mountLauncher();
    expect(text).toContain(S.resumeFailed);
    expect(text).toContain("failed to resolve home directory");
    expect(text).not.toContain(S.resumeEmpty);
  });

  it("keeps the empty-history wording when the list comes back with nothing in it", async () => {
    mocks.crsmListSessions.mockResolvedValue([]);
    const text = await mountLauncher();
    expect(text).toContain(S.resumeEmpty);
    expect(text).not.toContain(S.resumeFailed);
  });

  it("says neither when the list arrives", async () => {
    mocks.crsmListSessions.mockResolvedValue([
      {
        kind: "claude",
        id: "session-a",
        cwd: "C:/work/alpha",
        label: "alpha",
        preview: "opening prompt",
        last_activity: new Date().toISOString(),
        source: "index",
        source_path: "C:/work/alpha/index.jsonl",
        transcript_path: null,
        summary_file: null,
        files_modified: [],
        incomplete_tasks: [],
        has_user_messages: true,
      },
    ]);
    const text = await mountLauncher();
    expect(text).toContain("alpha");
    expect(text).not.toContain(S.resumeEmpty);
    expect(text).not.toContain(S.resumeFailed);
  });
});
