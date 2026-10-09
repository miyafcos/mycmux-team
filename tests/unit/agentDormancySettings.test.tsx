// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ memory: vi.fn() }));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(), getAvailableMemoryMiB: mocks.memory,
}));
vi.mock("../../src/lib/autonomyBridge", () => ({
  autonomyGetSettings: async () => ({ autoAdvance: true, attentionCards: true }),
  autonomySetSettings: async () => ({ autoAdvance: true, attentionCards: true }),
}));
import { AutomationTab } from "../../src/components/settings/tabs/AutomationTab";
import { AgentDormancyCandidates } from "../../src/components/layout/AgentDormancyCandidates";
import { DEFAULT_DORMANCY_PRESSURE_SETTINGS } from "../../src/lib/agentDormancy";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { AGENT_DORMANCY_REVIEW_EVENT, useAgentDormancyStore } from "../../src/stores/agentDormancyStore";

let host: HTMLDivElement;
let root: Root;
const previousSettings = useSettingsStore.getState();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useSettingsStore.setState({ dormancyPressureSettings: { ...DEFAULT_DORMANCY_PRESSURE_SETTINGS } });
  useAgentDormancyStore.setState({ sampled: false, proposals: [], approvals: {} });
  mocks.memory.mockResolvedValue(null);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useSettingsStore.setState(previousSettings);
  useAgentDormancyStore.setState({ sampled: false, proposals: [], approvals: {} });
  vi.unstubAllGlobals();
});

describe("pressure dormancy settings and review", () => {
  it("shows the time-only fallback when memory cannot be measured", async () => {
    await act(async () => root.render(<AutomationTab />));
    expect(host.textContent).toContain("空きメモリを取得できないため、時間制のみ");
    expect(host.querySelector<HTMLInputElement>("[aria-label='圧を知らせる空きメモリ (MiB)']")?.value).toBe("2048");
    expect(host.querySelector<HTMLInputElement>("[aria-label='強い圧を知らせる全ペイン数']")?.value).toBe("60");
  });
  it("shows the current memory measurement", async () => {
    mocks.memory.mockResolvedValue(2300);
    await act(async () => root.render(<AutomationTab />));
    expect(host.textContent).toContain("現在の空きメモリ: 2300 MiB");
  });
  it("requires an explicit click on a named candidate before requesting dormancy", async () => {
    useAgentDormancyStore.getState().setProposals([{ sessionId: "pty", resumeSessionId: "sid", agentKind: "claude",
      label: "提出済みの作業", workspaceName: "調査", lastActivityAt: 100, processStatusAt: 200,
      idleMinutes: 15, stage: "pressure" }]);
    const requested = vi.fn(); window.addEventListener(AGENT_DORMANCY_REVIEW_EVENT, requested);
    try {
      await act(async () => root.render(<AgentDormancyCandidates />));
      expect(host.textContent).toContain("提出済みの作業");
      expect(requested).not.toHaveBeenCalled();
      await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
      expect(requested).toHaveBeenCalledTimes(1);
      expect(useAgentDormancyStore.getState().approvals.pty.resumeSessionId).toBe("sid");
    } finally { window.removeEventListener(AGENT_DORMANCY_REVIEW_EVENT, requested); }
  });
});
