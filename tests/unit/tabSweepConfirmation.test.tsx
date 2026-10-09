// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SweepReport, SweepTab } from "../../src/components/layout/tabSweep";

const mocks = vi.hoisted(() => ({ scan: vi.fn(), apply: vi.fn(), judge: vi.fn() }));
vi.mock("../../src/components/layout/tabSweep", async (original) => ({
  ...await original<typeof import("../../src/components/layout/tabSweep")>(),
  scanTabs: mocks.scan,
  applySweep: mocks.apply,
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.judge,
}));
vi.mock("../../src/components/layout/PaneLeftoverProcesses", () => ({ PaneLeftoverProcesses: () => null }));

import { TabSweepButton } from "../../src/components/layout/TabSweepButton";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { __resetToastStoreForTests } from "../../src/stores/toastStore";

let root: Root;
let host: HTMLDivElement;
const item: SweepTab = {
  id: "done", sessionId: "pty", workspaceId: "workspace", workspaceName: "試験",
  paneId: "pane", label: "作業の確認", category: "CANDIDATE", lockReasons: [],
  unnamed: false, tail: ["完了しました", "❯"], processStatusReason: null, lastOutputAt: 1,
};
const report: SweepReport = { scannedAt: 600_001, tabs: [item], candidates: [item], dead: [], locked: [], unnamed: [] };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.scan.mockResolvedValue(report);
  mocks.apply.mockResolvedValue({ closed: 1, renamed: 0, skipped: [], errors: [] });
  mocks.judge.mockResolvedValue('[{"id":"done","verdict":"done_waiting","reason":"結果を提出して待機しています"}]');
  useSettingsStore.setState({ autoSweepCloseWithoutConfirmation: false });
  useAiSettingsStore.setState({ aiEnabled: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  __resetToastStoreForTests();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function openReview() {
  await act(async () => root.render(<TabSweepButton />));
  await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='ペイン掃除']")!.click());
}

describe("automatic sweep confirmation surface", () => {
  it("lists names, verdicts, reasons and process/restore limits before closing", async () => {
    await openReview();
    const panel = document.getElementById("tab-sweep-panel")!;
    for (const text of ["作業の確認", "done_waiting", "結果を提出して待機しています", "プロセスを終了", "記録は残ります", "取り消しは記録の復元で、実行状態は戻りません。"])
      expect(panel.textContent).toContain(text);
    expect(mocks.apply).not.toHaveBeenCalled();
    const confirm = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "確認して1件を閉じる")!;
    await act(async () => confirm.click());
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel", "escape", "unmount"])("%s abandons the review without closing any pane", async (route) => {
    await openReview();
    await act(async () => {
      if (route === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else if (route === "unmount") root.render(null);
      else [...document.getElementById("tab-sweep-panel")!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "キャンセル")!.click();
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("a late AI reply after unmount releases the runner without closing panes", async () => {
    let reply!: (output: string) => void;
    mocks.judge.mockReturnValue(new Promise((resolve) => { reply = resolve; }));
    await openReview();
    await act(async () => root.render(null));
    await act(async () => reply('[{"id":"done","verdict":"done_waiting"}]'));
    expect(mocks.apply).not.toHaveBeenCalled();
    mocks.judge.mockResolvedValue('[{"id":"done","verdict":"done_waiting"}]');
    await openReview();
    expect(document.getElementById("tab-sweep-panel")?.textContent).toContain("確認して1件を閉じる");
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
